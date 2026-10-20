# auth-capture 配图目录

源码版本和测试状态见[分享主稿](../../docs/auth-capture-contract-analysis.md#9-源码版本)。

配图使用“上限 10 USDC、实际消费 6、费用 1%”这个例子，说明合约设计和调用过程。[返回分享主稿](../../docs/auth-capture-contract-analysis.md)

## 正文使用的图

| 图 | 内容 | 图源 |
| --- | --- | --- |
| [12 项目关系](12-project-layers.png) | Coinbase Payments 与 x402 auth-capture 分别使用 Commerce Payments；不表示 Shopify 使用 x402 | [SVG](12-project-layers.svg) |
| [08 三种支付方式](08-auth-capture-overview.png) | exact 以 ERC-3009 默认直付为例；另两列为 delegated 的 escrow / authorization 路径 | [SVG](08-auth-capture-overview.svg) |
| [01 合约职责](01-contract-roles.png) | operator、Escrow、Collector、TokenStore 与收款方的职责和资金关系 | [Mermaid](01-contract-roles.mmd) |
| [11 Collector 继承与调用](11-collector-inheritance-call.png) | 区分代码继承和实际调用，基类没有独立中转地址 | [SVG](11-collector-inheritance-call.svg) |
| [10 capture 内部分账](10-capture-internal-split.png) | 一笔交易内的两个 token 转账、msg.sender 与失败回滚 | [SVG](10-capture-internal-split.svg) |
| [09 refund 资金](09-refund-funding.png) | 标准 delegated 退款从 operator 新收资金；示例默认关闭代办 | [SVG](09-refund-funding.svg) |
| [02 TokenStore 部署](02-tokenstore-deployment.png) | 地址可预测，先入金、首次支出时才部署实例 | [Mermaid](02-tokenstore-deployment.mmd) |
| [05 三个期限](05-deadlines.png) | 首次收款、capture、refund 的截止与主动 reclaim | [Mermaid](05-deadlines.mmd) |
| [03 两次 settle](03-settle-sequence.png) | 限定 delegated、有 receiverAuthorizer、sync escrow；不在业务前额外调用 /verify | [Mermaid](03-settle-sequence.mmd) |
| [07 TRON 适配](07-tron-port.png) | USDT + Permit2 首版移植方案，兼容性待验证 | [Mermaid](07-tron-port.mmd) |

## 补充图

| 图 | 用途 | 图源 |
| --- | --- | --- |
| [04 分账简图](04-fee-split.png) | 只看 6=5.94+0.06；完整调用说明以图 10 为准 | [Mermaid](04-fee-split.mmd) |
| [06 故障恢复](06-failure-recovery.png) | 区分仅签名、已广播不明、已托管和已扣款 | [Mermaid](06-failure-recovery.mmd) |

SVG 和 Mermaid 是可编辑的图源，正文用 PNG 在 GitHub 展示。Mermaid 图使用同目录的 mermaid-config.json；修改图源后，需要重新渲染 PNG，并检查文字、金额、箭头和适用模式。
