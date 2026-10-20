# x402 auth-capture 支付机制与合约分享

> 未经评审的研究草稿。合约测试、链上交易及 TRON 移植尚未验证。

更新：2026 年 10 月 20 日。

auth-capture 让用户先签一笔支付上限，再按实际金额结算。它提供两条路：**开工前先锁钱，完成后 capture；或者只拿签名，完成后 charge，一次收款并分账。**

![exact 与 authorize capture 及 charge 的流程对比](../assets/auth-capture/08-auth-capture-overview.png)

图中三种方式最终都付 6 USDC：exact 签固定金额并直付；authorize → capture 先托管 10 再扣 6；charge 签上限 10，最终净收 6。exact 以 ERC-3009 默认直付为例，后两条采用 delegated 模式、费用设为 1%，并保留合约退款额度。

它适合异步任务、按用量计费和一次会话内分次扣款。**每笔支付有额度和期限，不能反复充值，也不是长期自动续费。**

## 为什么要设计两条路

用户签名只是允许以后收款，钱仍在钱包。调用 authorize 才会把钱转进托管。两条路的区别是：商家开工前，要不要先把付款资金锁住。

| 对比 | exact | authorize → capture | charge |
| --- | --- | --- | --- |
| 用户签什么 | 固定支付 6 | 支付上限 10 | 支付上限 10 |
| 开工前的资金保障 | 签名本身不锁钱 | authorize(10)，先锁住 10 | 签名本身不锁钱 |
| 最终支付 6 怎么做 | 按签名支付 6 | capture(6)，剩余 4 另行释放 | charge(6)，当场收款并分账 |
| TokenStore | ERC-3009 直付例子不经过它 | 钱先留下，稍后付给商家 | 收进来，同一笔交易就分出去 |
| 剩余款处理 | 没有本方案托管余额 | void 或到期 reclaim | 没有剩余托管款，无需 void |
| 费用分账、退款额度 | 方案本身无统一机制 | 合约内置 | 合约内置 |

高成本、长耗时的任务，可以先 authorize，避免做完才发现收不到钱。短请求若能接受最后扣款失败的风险，可以用 charge，省掉单独的锁款交易。charge 覆盖一部分 exact 场景，但需要客户端和 facilitator 支持 auth-capture，并引入 operator 权限；要开放退款还需安排退款资金，不能直接当作 exact 的升级替代。

**两条 auth-capture 路径的钱都会进 TokenStore，区别是会不会留下来等后续结算。** capture 用已有托管款，不会再扣用户钱包；charge 则当场收钱。charge 成功后要退已付款，用 refund；失败则整笔回滚，不需要 void。

签上限 10、charge 实收 6 时，Collector 的细节不同：Permit2 直接收 6；ERC-3009 先收 10 到 Collector、同一交易退回 4，再将 6 转进 TokenStore。因此 ERC-3009 路径执行时仍需有 10 的余额。这里的“净收 6”不能理解为所有收款方式都只发生一笔 6 的转账。

## 谁来操作

买方是 payer，商家收款地址是 receiver。operator 是直接调用合约的地址；默认 delegated 模式里，就是 facilitator 的执行地址。商家通过签名或经过认证的委托请求决定扣多少、是否撤销或退款。

基础 Escrow 只检查 operator 权限和付款条款，不判断任务是否完成，也不验证商家的操作签名。delegated 模式由 facilitator 验证商家意图；需要链上验签或仲裁时，可以用自定义合约担任 operator。

## 合约怎么分工

![合约职责与调用关系](../assets/auth-capture/01-contract-roles.png)

| 合约 | 职责 |
| --- | --- |
| AuthCaptureEscrow | 记每笔支付的账，限制操作人、金额、费用和期限 |
| ERC3009PaymentCollector | 使用 token 的签名授权收款 |
| Permit2PaymentCollector | 通过 Permit2 收款，首次仍需准备 token allowance |
| OperatorRefundCollector | 标准退款路径从 operator 钱包收钱 |
| TokenStore | 保管托管款，只接受 Escrow 的支出指令 |

这些合约来自 Base 的 Commerce Payments，x402 负责把它们接入 HTTP 支付。

**TokenStore 按 operator 地址区分，不是每笔订单一个。** 同一条链、同一 Escrow 下，多笔支付共用资金容器，Escrow 按支付编号分别记账。Escrow 部署时创建模板；实例地址可提前计算，首次需要转出资金时再自动部署。一个 facilitator 使用多个执行地址，就会对应多个 TokenStore。

## 主合约管什么

PaymentInfo 是固定条款，PaymentState 是余额账本。合约把条款、链 ID 和 Escrow 地址算成 paymentInfoHash，作为支付编号。后续操作必须传回原条款，修改收款人或期限会变成另一笔支付。

| PaymentInfo 参数 | 含义 |
| --- | --- |
| operator / payer / receiver / token | 谁操作、谁付款、谁收款、用什么币 |
| maxAmount | 首次收款上限，使用代币最小单位 |
| preApprovalExpiry | 首次收款截止时间 |
| authorizationExpiry | 扣款截止时间；到达后买方可 reclaim |
| refundExpiry | 退款截止时间 |
| minFeeBps / maxFeeBps | 手续费率范围，100 bps = 1% |
| feeReceiver | 非零时固定费用地址；零时允许 operator 在扣款时指定 |
| salt | 区分不同支付；协议也可用它承诺授权地址等信息 |

三个期限满足：首次收款截止 ≤ 扣款截止 ≤ 退款截止。到达截止时刻，对应操作即失效。

PaymentState 只存三个字段：

- hasCollectedPayment：是否收过钱，全部退完也不重置。
- capturableAmount：剩余可扣的托管款。
- refundableAmount：已扣款中尚可退的额度，**不是另存的一笔退款准备金**。

| 函数 | 调用者 | 钱怎么动 |
| --- | --- | --- |
| authorize | operator | 买方 → 托管，建立可扣余额 |
| capture | operator | 托管 → 商家及费用方，可分次执行 |
| charge | operator | 同一笔交易内收款并分账，不留待扣余额 |
| void | operator | 退回全部剩余托管款 |
| reclaim | payer | 扣款到期后，取回全部剩余托管款 |
| refund | operator | 重新提供退款资金，退给买方 |

authorize 或 charge 对同一支付只能成功一次。capture 不能超过剩余托管款；refund 不能超过已扣且未退的金额，也不会恢复可扣余额。void 不能取消尚未收款的 token 签名。

合约收钱后会核对 TokenStore 的实际入金。各操作有重入保护，转账失败时，账本修改和转账一起回滚。

## x402 怎么驱动合约

客户端请求业务 API，收到 402 和 PAYMENT-REQUIRED 付款条件后签名，再携 PAYMENT-SIGNATURE 重试。服务端把支付数据交给 facilitator。

| 接口 | 作用 |
| --- | --- |
| GET /supported | 查询支持的链、方案和配置 |
| POST /verify | 检查、验签和模拟，不收钱 |
| POST /settle | 提交链上操作并处理交易结果 |

具体请求与交易顺序见[两次 settle 时序图](../assets/auth-capture/03-settle-sequence.png)。

**路径由商家服务端在业务接口的付款条件里配置**，客户端读取 402 返回的条件后签名：

| 服务端 extra 配置 | 官方 SDK 的处理顺序 |
| --- | --- |
| paymentFlow: "escrow"（默认） | settle → authorize → 执行业务 → settle → capture |
| paymentFlow: "authorization" | verify → 执行业务 → settle → charge |

escrow 的 captureMode="sync" 默认在请求结束阶段扣款，"deferred" 由应用稍后发起；charge 路径不设置 captureMode。/escrow、/charge 只是示例业务路由名，真实接口可以都叫 /generate-report，采用哪条路径取决于配置。

同一个 /settle 也处理 payload.type 为 capture、void、refund 的操作，没有另外规定 /refund 接口。**settle 成功的含义要看实际操作：authorize 成功只表示托管，capture 或 charge 成功才表示向商家付款。**

## 手续费怎么付

![一笔 capture 中的货款与手续费](../assets/auth-capture/04-fee-split.png)

托管 10 USDC，本次扣 6、手续费 1%：商家收到 5.94，费用方收到 0.06，剩余 4 继续托管。买方不用另转一笔手续费。

货款和费用是**一笔 capture 里的两次内部转账**，一起成功或回滚。合约支持零费率，也没有额外写死的协议费。gas 另由发交易的账户或代付方承担。

capture 后再 void 剩余款，才是两笔独立交易。官方 SDK 对后续 void 尽力执行，capture 成功不能当成剩余款已退回的证明。

## refund：退的是已付款，资金需要重新准备

![官方 delegated 退款的请求与资金路径](../assets/auth-capture/09-refund-funding.png)

void / reclaim 释放尚未花掉的托管款；refund 退已经 capture 或 charge 的款。**refundableAmount 是允许退款的额度，不是留在 TokenStore 的退款准备金。**

默认 delegated 模式下，商家批准退款，通过 SDK 发起；facilitator 验证授权、期限、额度和资金条件，再以原 operator 身份调用合约。标准 OperatorRefundCollector 从 operator 钱包收款，经过 TokenStore 退给原 payer，需要余额和 allowance。它不会自动向商家或手续费方追款。

例如已结算 6 USDC，商家收到 5.94、手续费方收到 0.06。全退时 operator 要新提供 6；这两方之前收到的钱不变，如何返还手续费、如何与商家对账，要另外约定。也可以先退 2、再退 4，累计不超过 6；必须在 refundExpiry 前执行。退款失败时，转账和额度更新一起回滚。

官方做到哪一步，要分开看：

| 层面 | 已核实的情况 |
| --- | --- |
| 合约与 SDK | 已实现 refund，存在成功、权限、期限和超额退款测试源码；本次未运行测试 |
| 官方 facilitator 示例 | 明确配置 refundFunding: false，默认拒绝 delegated 退款；不代表所有线上部署都关闭 |
| 接入方要补的部分 | 与商家的资金协议、退款余额及 allowance、审批和对账；设为 true 不会自动准备资金 |
| 实际使用情况 | 本次未核实生产退款案例或链上用量，无法判断采用规模 |

自定义 operator 的退款通过它自己的接口和规则执行，官方 facilitator 不代办。用户不能凭退款额度强制调用基础合约 refund；到期 reclaim 也只能取回尚未结算的余额。

源码：[退款函数](https://github.com/base/commerce-payments/blob/b748fdd7a830a655a19a530edcf2a94b9dc7d25f/src/AuthCaptureEscrow.sol#L351)、[官方示例开关](https://github.com/x402-foundation/x402/blob/faa1c694c66a3732aaabbce93bdae140e521a67d/examples/typescript/facilitator/auth-capture/index.ts#L133-L135)、[退款资金要求](https://github.com/x402-foundation/x402/blob/faa1c694c66a3732aaabbce93bdae140e521a67d/specs/schemes/auth-capture/scheme_auth_capture_evm.md#refund-funding)。

## Facilitator 挂了怎么办

![三个期限与允许的操作](../assets/auth-capture/05-deadlines.png)

合约不会自动退款。已托管的钱，原 operator 可以继续扣款或撤销；扣款到期后，买方可以主动 reclaim 剩余款，需要原始 PaymentInfo 和 gas 或代付。

已扣给商家的部分不能 reclaim。交易已经广播但结果不明时，要先查原交易和链上余额，避免重复付款。换一家 facilitator 通常也不能接管旧支付，因为 operator 地址已固定。

商家已交付却没及时 capture，也可能错过扣款期限。

## 实际应用

| 案例 | 能说明什么 |
| --- | --- |
| [Shopify / Coinbase Payments](https://www.coinbase.com/en-gb/blog/powering-the-future-of-ecommerce-introducing-coinbase-payments) | 商业支付使用 Commerce Payments 托管和结算；不能据此说它使用 x402 HTTP 接口 |
| [Execution Market](https://docs.execution.market/payments/escrow) | 项目文档描述通过 x402r 托管任务赏金、交付后释放；未独立验证订单量 |
| [x402r](https://www.x402r.org/) | 提供 operator 和仲裁扩展，官网标注 beta |
| [Circle Arc 电商 demo](https://github.com/circlefin/arc-ecommerce-payments/blob/master/README.md) | 测试网展示六种操作，可参考代码，不代表商业规模 |

资料核对于 2026 年 10 月 19 日。[Shopify 的 USDC 产品](https://help.shopify.com/en/manual/payments/shopify-payments/local-payment-methods/usdc-payments)不支持部分扣款或订阅商品，产品开放范围与合约能力要分开看。

## TRON 上要改什么

模型可以沿用，但不能只复制 Escrow。USDT + Permit2 首版需要移植 Escrow、TokenStore、Permit2PaymentCollector 和 OperatorRefundCollector，并接入 TRON SDK 与 facilitator。

重点核对：

- **CREATE2 地址预测**：TRON 使用 0x41 推导前缀，EVM 使用 0xff。TokenStore 先入金后部署，预测和实际地址必须一致。
- **签名与收款**：地址、chainId、PaymentInfo 哈希、Permit2 接口和 allowance 要匹配；现有 exact 的 witness 不能直接替代本方案 nonce。
- **执行与依赖**：验证编译器、重入锁、ERC-6492 / Multicall3 依赖，以及 Energy、模拟、回执和 pending 恢复。

移植方案尚未验证，具体兼容差异见 [TRON 官方说明](https://developers.tron.network/docs/tvm-vs-evm)。

## 源码

逐函数解释、参数细节和测试入口见[官方代码走读](auth-capture-official-code-walkthrough.md)。[全部配图及可编辑图源](../assets/auth-capture/)可单独使用。

本文依据 x402 提交 faa1c694c66a3732aaabbce93bdae140e521a67d 和 Commerce Payments 提交 b748fdd7a830a655a19a530edcf2a94b9dc7d25f，以 v1.1 为主。v1.0 扣款参数是 feeBps，v1.1 是 feeAmount，升级时必须配套核对部署、Collector、ABI 和签名配置。
