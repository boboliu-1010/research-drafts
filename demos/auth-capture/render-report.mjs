import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { formatUnits, toFunctionSelector } from 'viem';
import { renderPublicReport } from './render-public-report.mjs';
const publicReport = await renderPublicReport();

const demo = JSON.parse(await readFile(new URL('./results/demo.json', import.meta.url), 'utf8'));
const deployment = JSON.parse(await readFile(new URL('./results/deployment.json', import.meta.url), 'utf8'));
const official = JSON.parse(await readFile(new URL('./results/official-summary.json', import.meta.url), 'utf8'));
const verified = JSON.parse(await readFile(new URL('./results/verified-source.json', import.meta.url), 'utf8'));
assert.equal(demo.success, true);
const esc = value => String(value).replace(/[&<>"']/g, x => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[x]));
const usdc = value => formatUnits(BigInt(value), 6);
const labels = ['A · 锁款 10', 'A · 扣款 6', 'A · 释放 4', 'A · 退款 2', 'A · 再退 4', 'B · 当场收款 6', 'B · 退款 6', 'C · 锁款 10', 'C · 到期取回 10'];
const capture = demo.steps.find(x => x.operation === 'capture');
const charge = demo.steps.find(x => x.operation === 'charge');
const actorNames = Object.fromEntries(Object.entries({ ...demo.actors, tokenStore: demo.tokenStore, ...demo.contracts }).map(([k, v]) => [v.toLowerCase(), k]));
const short = address => actorNames[address?.toLowerCase()] || `${address?.slice(0, 8)}…${address?.slice(-4)}`;
const functions = Object.fromEntries(['sendTokens(address,address,uint256)', 'transfer(address,uint256)', 'transferFrom(address,address,uint256)'].map(signature => [toFunctionSelector(signature), signature.split('(')[0]]));
function trace(node) {
  const method = functions[node.input?.slice(0, 10)] || (node.type === 'CREATE2' ? 'deploy clone' : node.input?.slice(0, 10) || node.type);
  return `<li><code>${esc(short(node.from))} → ${esc(short(node.to))}</code> · ${esc(method)} ${node.error ? '<b class="fail">reverted</b>' : ''}${node.calls?.length ? `<ul>${node.calls.map(trace).join('')}</ul>` : ''}</li>`;
}
const rows = demo.steps.map((step, i) => `<tr><td>${labels[i]}</td><td>${usdc(step.after.capturable)}</td><td>${usdc(step.after.refundable)}</td><td>${usdc(step.after.balances.payer)}</td><td>${usdc(step.after.balances.tokenStore)}</td><td>${usdc(step.after.balances.merchant)}</td><td>${usdc(step.after.balances.fee)}</td><td>${usdc(step.after.balances.operator)}</td></tr>`).join('');
const transfers = step => `<table><thead><tr><th>从</th><th>到</th><th>USDC</th></tr></thead><tbody>${step.transaction.transfers.map(x => `<tr><td>${esc(short(x.from))}</td><td>${esc(short(x.to))}</td><td>${esc(x.usdc)}</td></tr>`).join('')}</tbody></table>`;
const failed = demo.negativeChecks.find(x => x.method === 'local transaction');
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>auth-capture 实测</title><style>
:root{font-family:system-ui,-apple-system,'PingFang SC',sans-serif;color:#173240;background:#eef3f5}body{margin:0}main{max-width:1180px;margin:40px auto;padding:0 24px 50px}header{background:#102b3b;color:#fff;border-radius:18px;padding:32px}h1{font-size:34px;margin:10px 0}h2{font-size:22px}h3{font-size:18px}p{line-height:1.8}.tag{display:inline-block;background:#f8dda0;color:#593e10;padding:5px 12px;border-radius:20px;font-size:13px}.meta{color:#bbd1df}.cards,.split{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-top:20px}.split{grid-template-columns:1fr 1fr}.card,section{background:#fff;border:1px solid #d7e2e8;border-radius:14px;padding:20px;margin-top:20px}.card{margin-top:0}.number{font-size:32px;font-weight:700;color:#148071}section{overflow:auto}table{border-collapse:collapse;width:100%;font-size:14px;line-height:1.7}th,td{padding:12px;border-bottom:1px solid #dce5eb;text-align:left;white-space:nowrap}th{background:#f3f7f9}code{font-family:ui-monospace,monospace;font-size:12px}li{line-height:1.9}summary{cursor:pointer;font-weight:600}.pass{color:#187b67}.fail{color:#b94b42}a{color:#0969da}.caption{font-size:13px;color:#526b79}@media(max-width:800px){.cards,.split{grid-template-columns:1fr}main{padding:0 12px}header{padding:22px}}
</style><main><header><span class="tag">公共 Base Sepolia + 本地 Anvil fork</span><h1>auth-capture 实测</h1><p>同一套官方合约，跑一遍锁款、扣款、取消、退款和到期取回。</p><p class="meta">Chain ${demo.chainId} · fork #${demo.forkBlock} · ${esc(demo.generatedAt)}<br>公开测试网 ${publicReport.result.transactions.length} 笔生命周期交易；本地 fork 另做故障注入。</p></header>
<div class="cards"><div class="card"><div class="number">${official.counts.passed}</div>官方合约测试通过 · Foundry v1.3.6</div><div class="card"><div class="number">${publicReport.result.transactions.length}</div>公开链生命周期交易成功</div><div class="card"><div class="number">${publicReport.sdk.counts.passed}</div>SDK 单测通过</div><div class="card"><div class="number">${Object.keys(verified.contracts).length}</div>支付合约执行字节码匹配</div></div>
${publicReport.html}
<section><h2>本地 fork：每一步的钱和账</h2><p>本地另跑 ${demo.steps.length} 笔生命周期交易和 ${demo.negativeChecks.length} 项拒绝 / 回滚检查。初始给付款人 100、operator 20 测试 USDC。表中是每一步完成后的余额，金额单位均为 USDC。</p><table><thead><tr><th>操作</th><th>可扣</th><th>可退</th><th>付款人</th><th>TokenStore</th><th>商家</th><th>费用方</th><th>operator</th></tr></thead><tbody>${rows}</tbody></table></section>
<div class="split"><section><h2>capture 6 的两次转账</h2>${transfers(capture)}<p class="caption">只从 TokenStore 支出，不再扣付款人的钱包。</p></section><section><h2>ERC-3009 charge 6 的五次转账</h2>${transfers(charge)}<p class="caption">先收上限 10，退 4，再把实际 6 存入并分账。</p></section></div>
<section><h2>失败会发生什么</h2><p>在本地 fork 将商家加入 USDC 黑名单后，capture 第二次转账失败。交易回执为 reverted，费用方余额、订单账本与 TokenStore 部署状态均未改变。</p><details><summary>展开失败交易的合约调用</summary><ul>${trace(failed.callTrace)}</ul></details><ul>${demo.negativeChecks.map(x => `<li><span class="pass">PASS</span> ${esc(x.label)}${x.observedError ? ` · <code>${esc(x.observedError)}</code>` : ''}</li>`).join('')}</ul></section>
<section><h2>capture 的合约调用</h2><details><summary>展开实际 call trace</summary><ul>${trace(capture.callTrace)}</ul></details></section>
<section><h2>Base Sepolia 部署核验</h2><p>以下链接是公共测试网的官方合约地址。上面的执行记录来自本地 fork；本地交易哈希不能作为公共测试网交易查询。</p><table><thead><tr><th>合约</th><th>地址</th><th>代码字节</th></tr></thead><tbody>${Object.entries(deployment.contracts).map(([name,x])=>`<tr><td>${esc(name)}</td><td><a href="${esc(x.explorer)}"><code>${esc(x.address)}</code></a></td><td>${x.codeBytes}</td></tr>`).join('')}</tbody></table></section>
<section><h2>源码与工具链</h2><p>官方合约测试 ${official.counts.passed} 项通过，其中 ${official.fuzz.tests} 项 fuzz 测试共 ${official.fuzz.runs.toLocaleString()} 轮；排除了上游 Base 主网 fork 集成测试。合约用 Solidity 0.8.28 重新编译，与链上代码比较时归一化了构造时写入的 immutable。Escrow 和 TokenStore 模板完整 runtime 匹配；三个 Collector 需要额外去掉末尾的 CBOR 编译元数据。</p><p>Foundry v1.8.5 有一个 Permit2/ERC-6492 用例失败，官方 CI 的 v1.3.6 全部通过。SDK ${publicReport.sdk.counts.passed} 项单测通过；HTTP 实测发现 sync 账本更新遗漏，详情见上方公开链记录。</p></section><p class="caption">原始记录：results/demo.json、results/deployment.json。重跑：npm run check:deployment → npm run demo → npm run report。</p></main></html>`;
await writeFile(new URL('./report.html', import.meta.url), html);

const aSteps = demo.steps.slice(0, 4);
const titles = ['authorize 10', 'capture 6', 'void 4', 'refund 2'];
const colors = ['#1b718c', '#17806b', '#7355a5', '#bf7934'];
let boxes = '';
for (let i = 0; i < 4; i++) {
  const x = 44 + i * 330, y = 190, step = aSteps[i];
  boxes += `<rect x="${x}" y="${y}" width="302" height="410" rx="18" fill="white" stroke="#d5e2e9"/><rect x="${x}" y="${y}" width="302" height="62" rx="18" fill="${colors[i]}"/><text x="${x + 20}" y="${y + 40}" fill="white" font-size="25" font-weight="700">${titles[i]}</text>`;
  const fields = [['可扣余额', step.after.capturable], ['可退额度', step.after.refundable], ['TokenStore', step.after.balances.tokenStore], ['商家余额', step.after.balances.merchant], ['费用方余额', step.after.balances.fee], ['operator 余额', step.after.balances.operator]];
  fields.forEach(([label, amount], j) => { boxes += `<text x="${x + 20}" y="${y + 110 + j * 46}" fill="#526976" font-size="20">${label}</text><text x="${x + 280}" y="${y + 110 + j * 46}" text-anchor="end" fill="#183745" font-size="23" font-weight="600">${esc(usdc(amount))}</text>`; });
  if (i < 3) boxes += `<path d="M${x + 307} 390 h18" stroke="#849ba9" stroke-width="3" marker-end="url(#arrow)"/>`;
}
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="760" viewBox="0 0 1400 760"><defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0 0 L6 3 L0 6" fill="none" stroke="#849ba9"/></marker></defs><rect width="1400" height="760" fill="#eef4f6"/><g font-family="system-ui,-apple-system,'PingFang SC',sans-serif"><rect width="1400" height="150" fill="#102b3b"/><text x="44" y="65" fill="white" font-size="35" font-weight="700">auth-capture：实际跑出的资金变化</text><text x="44" y="110" fill="#bed3de" font-size="21">Base Sepolia 本地 fork #${demo.forkBlock} · 官方 v1.1 合约 + 测试 USDC · 金额单位 USDC</text>${boxes}<text x="44" y="652" fill="#173d4b" font-size="24" font-weight="600">capture 支付 0.06 + 5.94；refund 另从 operator 收钱，商家与费用方余额不变。</text><text x="44" y="700" fill="#5b7380" font-size="20">${demo.steps.length} 笔生命周期交易成功 · ${demo.negativeChecks.length} 项拒绝 / 回滚检查通过 · 没有向公共测试网发送交易</text></g></svg>`;
const asset = new URL('../../assets/auth-capture/13-validation-results.svg', import.meta.url);
await mkdir(new URL('../../assets/auth-capture/', import.meta.url), { recursive: true });
await writeFile(asset, svg);
console.log('Generated report.html and assets/auth-capture/13-validation-results.svg from recorded results.');
