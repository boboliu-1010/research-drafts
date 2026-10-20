# x402 auth-capture：支付机制与合约分享

> 未经评审的研究草稿。基于官方固定源码，未运行合约或 SDK 测试，未验证 TRON 部署。

更新：2026 年 10 月 20 日。[总目录](../README.md) · [基础概念](auth-capture-foundations.md) · [合约源码](auth-capture-solidity-walkthrough.md) · [SDK 与接口](auth-capture-official-code-walkthrough.md) · [TRON 适配](auth-capture-tron-port.md)

**auth-capture 让用户先同意一笔支付上限，再按实际金额结算。** 商家可以先锁住资金再开工，也可以先拿到签名，等业务完成后一次收款并分账。全文使用“上限 10 USDC、实际消费 6、费用 1%”这个例子。

## 1 先分清 Commerce Payments 和 x402

Commerce Payments 是 Coinbase 与 Shopify 推出的开源商业支付协议，提供托管、扣款、取消和退款合约。x402 是 API 等资源的支付协议；它的 auth-capture 方案接入这套合约。Coinbase Payments 则是包含结账和商家 API 的商业产品。[官方产品介绍](https://www.coinbase.com/en-gb/blog/powering-the-future-of-ecommerce-introducing-coinbase-payments)

Escrow、TokenStore、Collector 是支付系统的配套合约，不是 EVM 自带的功能。x402 这次主要新增或完善 SDK，生产合约复用 Commerce Payments。项目关系、合约来源和应用证据见[基础概念](auth-capture-foundations.md)。

## 2 为什么有 authorize → capture 和 charge 两条路

![exact、先托管后扣款、当场收款的对比](../assets/auth-capture/08-auth-capture-overview.png)

| 对比 | exact | authorize → capture | charge |
| --- | --- | --- | --- |
| 用户签什么 | 固定金额 6 | 上限 10 | 上限 10 |
| 开工前 | 签名本身不锁钱 | authorize(10)，先锁住 10 | 签名本身不锁钱 |
| 业务完成后 | 按固定金额支付 6 | capture(6)，剩余 4 另行释放 | charge(6)，当场收款并分账 |
| TokenStore | 图中 ERC-3009 直付路径不经过它 | 钱先留下，稍后结算 | 收进来，同一交易分出去 |
| 取消 / 退款 | 商家可另行转账退款，无本方案退款账本 | 剩余款 void / 到期 reclaim；已付款 refund | 无剩余款，无需 void；已付款 refund |

成本高或耗时长的任务适合先锁钱。对于较短的请求，如果商家能接受最后扣款失败的风险，可以用 charge，省掉单独锁款的交易。charge 能覆盖部分 exact 场景，但客户端和 facilitator 都要支持 auth-capture，也要安排好 operator 权限，不能只改一个配置就替换 exact。

**两条路都会经过 TokenStore，差别是钱会不会留在那里等后续结算。** 签名不等于资金保障，charge 执行时仍可能余额不足或授权过期。

同样是净付 6，实际转账过程还取决于收款方式。Permit2 直接收 6；ERC-3009 Collector 先收上限 10，在同一交易中退回 4，再把 6 存入 TokenStore，因此执行时钱包仍需有 10 的余额。每笔支付只能首次收款一次，不能充值，也不能据此长期自动续费。

## 3 合约重点：谁管账，谁收钱，谁持币

![合约职责与资金关系](../assets/auth-capture/01-contract-roles.png)

| 组件 | 职责 |
| --- | --- |
| AuthCaptureEscrow | 保存订单余额，限制操作人、金额、费用和期限 |
| 具体 Collector | 把外部资金收进 TokenStore：ERC-3009 / Permit2 收用户款，Refund Collector 收 operator 的退款资金 |
| TokenStore | 持有资金，只接受指定 Escrow 的支出指令 |

TokenCollector 是三个具体 Collector 的抽象基类，没有独立的中转地址。继承的入口检查调用者，子类负责实际收款；Escrow 再核对 TokenStore 的实际到账金额。[继承与调用图](auth-capture-solidity-walkthrough.md#8-tokencollector-与具体-collector先看继承再看收款)

PaymentInfo 保存固定条款，PaymentState 记录是否收过款、剩余可扣托管款、已扣未退额度这三项状态。修改条款会变成另一笔支付，退完钱也不会重置收款标记。多笔订单可以共用同一个 operator 的 TokenStore，Escrow 仍按订单分别记账。

默认 delegated 模式下，operator 是 facilitator 控制的提交地址。商家通过签名或经过认证的委托请求，告诉它要扣多少钱。**基础 Escrow 不判断业务是否交付，也不验证商家的操作签名；这层校验由 facilitator 做。** 需要链上规则或仲裁时，可以使用 custom operator，后续操作通过它自己的接口执行，不由 x402 relay 代办。

六种操作、参数、逐层 msg.sender 和源码行号见[Solidity 走读](auth-capture-solidity-walkthrough.md)。

## 4 内部分账：一笔交易，支付给两方

![capture 的调用与回滚边界](../assets/auth-capture/10-capture-internal-split.png)

capture 总额为 6，手续费是 0.06，商家收到 5.94。Escrow 先把本订单的可扣余额从 10 改为 4、可退额度从 0 改为 6，再指令 TokenStore 依次支付费用方和商家。USDC 从 TokenStore 地址转出，不会再扣用户钱包。

这是一笔交易中的两次 ERC-20 转账，浏览器通常显示一个哈希、两条 Transfer 记录。任一步失败，前面的分账、订单记账和事件一起回滚；失败交易仍消耗 gas。费用包含在 6 内，gas 由发送账户或代付方另付。

费率受用户签署的条款限制。合约支持零费用，没有额外写死的协议费；charge 收款后也使用同一个分账函数。capture 后再 void 剩余 4，需要另一笔交易。因此 capture 成功，并不能证明剩余款已经退回。[源码解释](auth-capture-solidity-walkthrough.md#9-capture把可扣余额转换为可退额度)

## 5 取消和退款：两笔不同的钱

![退款请求与新资金来源](../assets/auth-capture/09-refund-funding.png)

- **尚未花掉的 4**：operator 通过 void 全部退回；到达扣款期限后，payer 可以主动 reclaim。
- **已经付出去的 6**：走 refund，可部分、多次退款，但不能超过已扣未退额度，必须早于退款截止时刻。

标准退款要从 operator 钱包另收一笔资金，经 TokenStore 退给原 payer，因此 operator 需要有余额和 allowance。合约不会自动追回商家已经收到的 5.94 和费用方的 0.06；手续费是否返还、如何与商家对账，要另外约定。**refundableAmount 是额度，不是准备金。**

官方合约和 SDK 已实现 refund，也有相应测试源码。官方 facilitator 示例默认 refundFunding=false，接入方需要先约定退款资金如何承担，再开放退款。这个默认配置不代表所有部署都关闭了退款；本文没有核实生产退款案例和用量。[退款接入细节](auth-capture-official-code-walkthrough.md#8-退款如何接入)

合约到期后不会自动转账。facilitator 不可用时，payer 只能等到期后 reclaim 尚未结算的余额，不能追回已付款。旧订单固定了 operator，换一家 facilitator 通常无法接管。交易已经广播却不知结果时，应先查原交易和链上状态。

## 6 x402 如何驱动合约

商家服务端在业务路由的 extra 中选择路径，客户端根据 402 返回的付款条件签名：

| 配置 | 官方 SDK 的处理顺序 |
| --- | --- |
| paymentFlow="escrow"（默认） | /settle 调 authorize → 执行业务 → /settle 调 capture |
| paymentFlow="authorization" | /verify → 执行业务 → /settle 调 charge |

escrow 的 captureMode="sync" 默认在请求结束阶段扣款，"deferred" 则稍后扣款；charge 不设置 captureMode。/escrow、/charge 只是示例名称，真实业务接口可以自行命名。

/settle 也处理 capture、void、refund 等后续操作，协议没有另外规定 /refund HTTP 接口。authorize 成功表示钱已托管，capture / charge 成功才表示已经付款。接口、签名、状态存储和失败恢复见[SDK 与接口走读](auth-capture-official-code-walkthrough.md)。

## 7 TRON 上要做什么

建议首版限定为 USDT + Permit2 + 单一 delegated operator。需要移植 Escrow、TokenStore、Permit2PaymentCollector、OperatorRefundCollector，以及配套 SDK 和 facilitator；仅复制 Escrow 不够。

写一个 3009 Collector，不会让现有 USDT 获得签名收款能力。移植时要重点验证 CREATE2 地址预测、Permit2 接口与签名、TVM 编译依赖，以及 Energy、交易模拟和对账。具体范围与步骤见[TRON 适配](auth-capture-tron-port.md)，方案尚未做链上验证。

源码版本、应用证据和研究范围统一见[基础概念与来源](auth-capture-foundations.md#6-源码版本与验证范围)。[全部配图与图源](../assets/auth-capture/README.md)可单独使用。
