import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { formatUnits } from 'viem';

export async function renderPublicReport() {
  const result = JSON.parse(await readFile(new URL('./results/public-demo.json', import.meta.url), 'utf8'));
  const sdk = JSON.parse(await readFile(new URL('./results/sdk-summary.json', import.meta.url), 'utf8'));
  assert.equal(result.complete, true, 'Public run is not complete');
  assert.equal(sdk.success, true);
  const esc = x => String(x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const units = x => formatUnits(BigInt(x), 6);
  const find = name => result.transactions.find(t => t.events.some(e => e.name === name));
  const capture = find('PaymentCaptured'), charge = find('PaymentCharged'), refund = find('PaymentRefunded'), reclaim = find('PaymentReclaimed');
  const names = Object.fromEntries(Object.entries({ ...result.actors, tokenStore: result.tokenStore, erc3009: result.contracts.erc3009, permit2Collector: result.contracts.permit2Collector }).map(([k, v]) => [v.toLowerCase(), k]));
  const actor = address => names[address.toLowerCase()] ?? address;
  const link = t => `<a href="${esc(t.explorer)}"><code>${t.hash.slice(0, 12)}…${t.hash.slice(-6)}</code></a>`;
  const transferTable = t => `<table><thead><tr><th>从</th><th>到</th><th>USDC</th></tr></thead><tbody>${t.transfers.map(x => `<tr><td>${esc(actor(x.from))}</td><td>${esc(actor(x.to))}</td><td>${x.usdc}</td></tr>`).join('')}</tbody></table>`;
  const issue = result.issues.find(x => x.id === 'sync-storage-after-settle');
  const issueHtml = issue ? `<section style="border-color:#c88a35;background:#fff6e8"><h2>发现的问题：sync 后 SDK 账本没有同步</h2><p>链上已经 capture 0.006、void 0.004，SDK 存储仍显示可扣 0.01、可退 0。再调用 lifecycle.refund 时返回 <code>${esc(issue.observedError)}</code>，没有广播退款交易。</p><p>core 向 facilitator 发送了补齐后的 capture payload，却将原 collect payload 传给 afterSettle。auth-capture 的回调看不到 type=capture，因而漏更新存储。SDK 源码保持原样，本地无链复现也得到相同结果。</p><p>该笔退款由 operator 直接调用 Escrow 完成，不能算 SDK 退款流程通过。<a href="https://sepolia.basescan.org/tx/${esc(issue.recoveryTransaction)}">查看恢复退款回执</a>。接入前需要修复回调的数据传递并补回归测试。</p></section>` : '';
  const pathways = result.payments.map(p => {
    const states = result.checks.filter(x => x.paymentInfoHash === p.paymentInfoHash);
    const s = states.at(-1)?.expectedState;
    return `<tr><td><code>${esc(p.path)}</code></td><td>402 → 签名重试 → 200</td><td>${p.assetTransferMethod}</td><td>${units(s.capturable)} / ${units(s.refundable)}</td></tr>`;
  }).join('');
  const html = `<section id="public"><h2>公共 Base Sepolia：完整支付链路</h2><p>实际运行官方 SDK 的 client、Express middleware 和 facilitator。六条业务路由都经过 402、客户端签名、HTTP 重试和真实链上结算。operator 与付款人是两个测试钱包，业务服务自己签署操作授权。</p><p><b>${result.transactions.length} 笔生命周期交易成功</b>，保留了 ${result.checks.length} 条状态、权限与资金核对记录。SDK 单测 ${sdk.counts.passed} 项通过。所有时间等待均使用公共链区块时间。</p><table><thead><tr><th>业务路由</th><th>HTTP</th><th>收款方式</th><th>最终可扣 / 可退 USDC</th></tr></thead><tbody>${pathways}</tbody></table></section>
${issueHtml}<div class="split"><section><h2>公开 capture 回执</h2><p>${link(capture)} · 区块 ${capture.blockNumber}</p>${transferTable(capture)}<p>扣款总额 0.006 = 手续费 0.00006 + 商家到账 0.00594。</p></section><section><h2>公开 refund 回执</h2><p>${link(refund)} · 区块 ${refund.blockNumber}</p>${transferTable(refund)}<p>退款资金从 operator 新收，未扣商家和费用方。</p></section></div>
<section><h2>charge：两种 Collector 的真实转账</h2><p>授权上限 0.01，实际收款 0.006。ERC-3009 先收 0.01、退 0.004；Permit2 只拉取 0.006，随后同样分账。</p><div class="split">${result.transactions.filter(t => t.events.some(e => e.name === 'PaymentCharged')).map((t, i) => `<div><h3>${i === 0 ? 'ERC-3009' : 'Permit2'} · ${link(t)}</h3>${transferTable(t)}</div>`).join('')}</div></section>
<section><h2>到期不会自动退款</h2><p>测试先验证过早 reclaim 被拒绝，等公共区块时间超过 authorizationExpiry 后，验证 capture 被拒绝，再由 payer 发出 reclaim。${link(reclaim)}</p><h3>所有生命周期交易</h3><details><summary>展开 ${result.transactions.length} 笔公开回执</summary><table><thead><tr><th>操作</th><th>交易</th><th>区块</th><th>结果</th></tr></thead><tbody>${result.transactions.map(t => `<tr><td>${esc(t.events.map(e => e.name).join(', '))}</td><td>${link(t)}</td><td>${t.blockNumber}</td><td>${t.status}</td></tr>`).join('')}</tbody></table></details><p>收尾后 TokenStore 余额为 0，六笔订单的可扣与可退额度均为 0；撤销了这次设置的 Permit2 和退款 allowance。退款共从 operator 支出 ${units(-BigInt(result.balanceDeltas.operator))} USDC，商家与费用方保留原到账金额。</p><p class="caption">原始结果：results/public-demo.json。公开链验证使用 EOA 和商家自行签名模式；回滚故障注入在下方本地 fork 中演示。</p></section>`;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="960" viewBox="0 0 1440 960" role="img" aria-label="Base Sepolia 公开验证：授权扣款和 charge 两条路径"><defs><marker id="arrow" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto"><path d="M0 0 L7 4 L0 8" fill="none" stroke="#6e8794" stroke-width="2"/></marker></defs><rect width="1440" height="960" fill="#f0f5f7"/><g font-family="system-ui,-apple-system,'PingFang SC',sans-serif"><rect width="1440" height="148" fill="#122f40"/><text x="48" y="63" fill="white" font-size="36" font-weight="700">Base Sepolia：从 HTTP 请求到真实分账</text><text x="48" y="112" fill="#bcd5e3" font-size="22">官方 v1.1 合约 · ERC-3009 / Permit2 均跑通 · 六条路由均为 402 → 签名 → 200</text>
<rect x="40" y="182" width="1360" height="252" rx="20" fill="white" stroke="#d8e4eb"/><text x="68" y="222" fill="#196a86" font-size="25" font-weight="700">先托管，再扣款：authorize → capture</text>
<rect x="68" y="250" width="240" height="100" rx="14" fill="#e9f3f8"/><text x="188" y="287" text-anchor="middle" fill="#173746" font-size="23">authorize 0.01</text><text x="188" y="323" text-anchor="middle" fill="#527383" font-size="20">钱先进入 TokenStore</text>
<path d="M314 300 H358" stroke="#6e8794" stroke-width="3" marker-end="url(#arrow)"/><rect x="372" y="250" width="242" height="100" rx="14" fill="#e5f4ee"/><text x="493" y="287" text-anchor="middle" fill="#176f59" font-size="23">capture 0.006</text><text x="493" y="323" text-anchor="middle" fill="#527383" font-size="20">一笔交易，两次分账</text>
<path d="M621 300 H665" stroke="#6e8794" stroke-width="3" marker-end="url(#arrow)"/><rect x="680" y="250" width="286" height="100" rx="14" fill="#f1ebfa"/><text x="823" y="287" text-anchor="middle" fill="#6b4b98" font-size="23">void 剩余 0.004</text><text x="823" y="323" text-anchor="middle" fill="#527383" font-size="20">托管余款退回 payer</text>
<path d="M973 300 H1017" stroke="#6e8794" stroke-width="3" marker-end="url(#arrow)"/><rect x="1032" y="250" width="300" height="100" rx="14" fill="#fff3e5"/><text x="1182" y="287" text-anchor="middle" fill="#9f6630" font-size="23">refund 0.002 + 0.004</text><text x="1182" y="323" text-anchor="middle" fill="#527383" font-size="20">另扣 operator 的备付金</text>
<text x="68" y="397" fill="#537181" font-size="21">ERC-3009 和 Permit2 分别完成了这套流程，最后可扣 / 可退额度均为 0。</text>
<rect x="40" y="460" width="1360" height="208" rx="20" fill="white" stroke="#d8e4eb"/><text x="68" y="500" fill="#196a86" font-size="25" font-weight="700">结束时收款：charge</text><text x="68" y="546" fill="#173746" font-size="23">签名上限 0.01 → 业务消费 0.006 → charge 0.006 → refund 0.006</text><text x="68" y="590" fill="#537181" font-size="21">ERC-3009：先收 0.01，退 0.004，再分账；Permit2：直接拉取 0.006，再分账。</text><text x="68" y="634" fill="#537181" font-size="21">两种方式都没有留下可 void 的托管余额。退款仍需从 operator 另行出资。</text>
<rect x="40" y="696" width="660" height="144" rx="18" fill="#122f40"/><text x="66" y="741" fill="#bad9e7" font-size="22">capture / charge 的 1% 分账</text><text x="66" y="791" fill="white" font-size="29" font-weight="700">0.006 = 0.00006 + 0.00594 USDC</text>
<rect x="726" y="696" width="674" height="144" rx="18" fill="#e3f0ea"/><text x="752" y="741" fill="#32624f" font-size="22">到期保护也做了公开链验证</text><text x="752" y="790" fill="#173f30" font-size="24">等区块时间到期 → payer 主动 reclaim</text>
<text x="48" y="892" fill="#173746" font-size="23" font-weight="600">${result.transactions.length} 笔生命周期交易成功 · SDK ${sdk.counts.passed} 项单测通过 · sync 账本问题已复现</text><text x="48" y="932" fill="#5c7786" font-size="20">sync 的退款经 operator 直接调用完成；其余四条主路径的收款与退款均经过 SDK。</text></g></svg>`;
  await writeFile(new URL('../../assets/auth-capture/14-public-validation.svg', import.meta.url), svg);
  return { html, result, sdk, capture, charge, refund, reclaim };
}
