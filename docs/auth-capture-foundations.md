# auth-capture 基础：项目、角色与合约来源

> 未经评审的研究草稿。本文解释支付模型与来源，运行验证范围见文末。

更新：2026 年 10 月 20 日。[总目录](../README.md) · [分享主稿](auth-capture-contract-analysis.md) · [合约源码](auth-capture-solidity-walkthrough.md) · [SDK 与接口](auth-capture-official-code-walkthrough.md) · [TRON 适配](auth-capture-tron-port.md)

## 1 Commerce Payments 是什么

Commerce Payments Protocol 是 Coinbase 与 Shopify 推出的开源链上商业支付协议，提供先托管后结算、取消、退款等支付操作。实现位于 [base/commerce-payments](https://github.com/base/commerce-payments)，不是 EVM 内置能力。

| 名称 | 负责哪一层 |
| --- | --- |
| Commerce Payments Protocol | 开源的链上支付合约，包括 Escrow、TokenStore 和 Collector |
| Coinbase Payments | 商业支付产品，包含钱包结账、商家 API 和链上执行层 |
| x402 | 面向 API 等资源的支付协议；本次研究的 auth-capture 方案接入 Commerce Payments |

![Commerce Payments、Coinbase Payments 与 x402 的关系](../assets/auth-capture/12-project-layers.png)

Coinbase 的[产品介绍](https://www.coinbase.com/en-gb/blog/powering-the-future-of-ecommerce-introducing-coinbase-payments)把 Commerce Payments Protocol 列为链上执行层，并说明 Shopify 的 USDC 支付使用了它。x402 的[官方 EVM 规范](https://github.com/x402-foundation/x402/blob/faa1c694c66a3732aaabbce93bdae140e521a67d/specs/schemes/auth-capture/scheme_auth_capture_evm.md)也明确复用 Commerce Payments。但 Shopify 使用这套合约，并不代表它使用了 x402 HTTP 接口。

## 2 auth-capture 解决什么问题

签名表示允许以后收款，钱仍在用户钱包；authorize 才真正把钱转进托管。商家可以先锁钱，执行任务后按实际金额 capture；也可以只拿签名，在业务完成后用 charge 一次收款并分账。

它适合异步任务、按用量计费，以及在一笔授权内分次付款。每笔支付都有上限和期限，只能首次收款一次，不能反复充值，也不等于长期自动续费。金额和资金路径对比见[分享稿第 2 节](auth-capture-contract-analysis.md#2-为什么有-authorize--capture-和-charge-两条路)。

| 操作 | 调用者 | 处理哪笔钱 |
| --- | --- | --- |
| authorize | operator | 从用户收款，建立托管余额 |
| capture | operator | 从已有托管余额向商家及费用方付款 |
| charge | operator | 当场收款并分账，不留下待扣余额 |
| void | operator | 退回全部剩余托管款 |
| reclaim | payer | 到期后主动取回全部剩余托管款 |
| refund | operator | 新提供资金，退还已付款 |

## 3 谁参与，谁有权操作

| 名称 | 身份与权限 |
| --- | --- |
| payer | 买方钱包，支付及退款接收人，reclaim 的调用者 |
| receiver | 商家货款接收地址；对应 HTTP 付款条件的 payTo |
| operator | 合约认定的操作地址；除 reclaim 外，五个资金操作只允许它调用 |
| facilitator | 验证、模拟、广播和对账的服务；默认 delegated 模式下控制 operator 地址 |
| receiverAuthorizer | 商家操作授权的签名地址，可由商家自管，也可经认证委托给 facilitator |
| feeReceiver | 费用接收地址，不必与商家或 operator 相同 |

operator 是一个地址角色，facilitator 是提供支付服务的程序，二者并不总是一回事。delegated 的 operator 可以是 EOA，也可以是 facilitator 控制的智能账户；custom 的 operator 则是应用自定义合约。

默认 delegated 模式下，基础 Escrow 只检查 operator 和用户固定条款，不验证商家操作签名，也不判断业务是否交付。这些商家意图由 facilitator 校验。custom 可以在自己的合约中增加规则，后续操作通过其接口处理，不由官方 relay 代办。policy 在本文使用的 SDK 快照中仍是保留类型。

## 4 支付配套合约与通用依赖

按用途看，这些是为 auth-capture 实现的配套合约；按代码来源看，它们未必是本次 x402 SDK 更新才写出来的。

| 分类 | 内容 | 与本次接入的关系 |
| --- | --- | --- |
| 支付业务合约，5 类 | AuthCaptureEscrow、TokenStore、ERC3009PaymentCollector、Permit2PaymentCollector、OperatorRefundCollector | 为这套支付系统实现，由 x402 复用 Commerce Payments 的实现 |
| 支付辅助基类 | TokenCollector、ERC6492SignatureHandler | 随具体合约编译继承，不额外计为两类业务合约 |
| 通用应用合约 | token（如 USDC）、Permit2、Multicall3 | 部署在链上的通用依赖，不是 EVM 原生功能 |
| 通用库 / 基类 | SafeERC20、LibClone、ReentrancyGuardTransient | 安全转账、clone、重入锁 |
| EVM 底层能力 | CALL、存储、哈希、CREATE2 等 | 提供合约运行能力，本身不理解支付订单 |

TokenCollector 是抽象基类；具体 Collector 负责把外部资金收进 TokenStore，基类没有单独的中转地址。[继承与调用走读](auth-capture-solidity-walkthrough.md#8-tokencollector-与具体-collector先看继承再看收款)

Commerce Payments 还有 PreApprovalPaymentCollector、SpendPermissionPaymentCollector 等收款方式，未计入当前 x402 ERC-3009 / Permit2 标准路径。

### 本次 x402 SDK 更新实际新增了什么

核对 [#3203](https://github.com/x402-foundation/x402/pull/3203) 的提交 [28376d6](https://github.com/x402-foundation/x402/commit/28376d643a6d9492e4a6cbfa5199376b90eb89dc)后可见，164 个变更文件中没有生产 Solidity 合约变更。这次主要新增或完善了 client / server / facilitator 的授权、结算和生命周期管理。abi.ts 描述的是已有合约的接口，不是新的合约实现。

新增的 Solidity 仅有三个集成测试 operator：

| 合约 | 测试用途 |
| --- | --- |
| ForwardingOperator | 将 authorize / charge 转发给 Escrow |
| NoopOperator | 调用不 revert，但不产生实际收款，测试假成功识别 |
| GasWastingOperator | 消耗过多 gas，测试调用限制 |

官方[测试说明](https://github.com/x402-foundation/x402/blob/faa1c694c66a3732aaabbce93bdae140e521a67d/typescript/packages/mechanisms/evm/test/contracts/auth-capture/README.md)限定它们用于集成测试，不能当作生产 operator 模板。Commerce Payments 自身 v1.0→v1.1 的 feeBps→feeAmount 则属于另一条版本升级。

## 5 实际应用能证明什么

| 案例 | 已有资料能支持的结论 | 不能据此推断 |
| --- | --- | --- |
| [Shopify / Coinbase Payments](https://www.coinbase.com/en-gb/blog/powering-the-future-of-ecommerce-introducing-coinbase-payments) | 商业支付使用 Commerce Payments 的托管与结算基础设施 | 已经采用本次 x402 HTTP 方案，或支持全部合约能力 |
| [Execution Market](https://docs.execution.market/payments/escrow) | 项目自述通过 x402r 托管任务赏金、交付后释放 | 已独立核实订单量或生产退款用量 |
| [x402r](https://www.x402r.org/) | 提供 operator 和仲裁扩展，资料核对时官网标注 beta | 与上游默认 delegated 模式完全一致 |
| [Circle Arc 电商 demo](https://github.com/circlefin/arc-ecommerce-payments/blob/master/README.md) | 测试网展示六种操作，可参考实现 | 已商业化或有相应交易规模 |

案例资料核对于 2026 年 10 月 19 日。[Shopify USDC 产品说明](https://help.shopify.com/en/manual/payments/shopify-payments/local-payment-methods/usdc-payments)当时不支持部分扣款或订阅商品，因此产品开放范围不能等同于合约的全部能力。本文没有核实生产退款案例和用量，不能据此判断“没人用”或“功能未生效”。

## 6 源码版本与验证范围

| 项目 | 固定提交 | 用途 |
| --- | --- | --- |
| [x402-foundation/x402](https://github.com/x402-foundation/x402/tree/faa1c694c66a3732aaabbce93bdae140e521a67d) | faa1c694c66a3732aaabbce93bdae140e521a67d，2026-10-15 UTC | TypeScript SDK、规范、示例与测试源码 |
| [base/commerce-payments](https://github.com/base/commerce-payments/tree/b748fdd7a830a655a19a530edcf2a94b9dc7d25f) | b748fdd7a830a655a19a530edcf2a94b9dc7d25f，2026-09-03 UTC | Commerce Payments v1.1 合约与测试源码 |

合约已按文中固定的提交核对，文档列出了函数行号和测试入口。尚未运行 SDK / Foundry 测试、故障注入或生产链上交易，也未验证 TRON 部署。仓库 main 中的实现不一定已经发布到 npm。

EVM 部分以 v1.1 的 feeAmount 为准，v1.0 使用 feeBps。切换版本时，部署地址、Collector、ABI 和操作签名都要配套，不能只改参数名称。

继续阅读：[合约源码](auth-capture-solidity-walkthrough.md) → [SDK 与接口](auth-capture-official-code-walkthrough.md) → [TRON 适配](auth-capture-tron-port.md)。
