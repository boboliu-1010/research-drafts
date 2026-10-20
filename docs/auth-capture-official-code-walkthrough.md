# x402 auth-capture SDK、接口与 TRON 接入

> 未经评审的研究草稿。TypeScript 静态源码分析，未运行 SDK 测试或链上交易。

更新：2026 年 10 月 20 日。[总目录](../README.md) · [分享主稿](auth-capture-contract-analysis.md) · [合约源码](auth-capture-solidity-walkthrough.md) · [TRON 适配](#11-tron-适配)

本文顺着一笔支付往下读：服务端给出付款条件，客户端签名，facilitator 调用合约，再保存状态、处理重试。合约内部实现见 Solidity 走读；固定提交和验证范围见[来源说明](auth-capture-contract-analysis.md#9-源码版本与验证范围)。

## 1 代码入口与职责

| 导入 / 文件位置 | 负责什么 |
| --- | --- |
| auth-capture/client/scheme.ts | 根据付款条件构造用户 token 授权 |
| auth-capture/server/scheme.ts | 形成条款、选择路径和 authorizer 配置 |
| server/settlementHooks.ts | 在业务前后补齐结算数据、记录结果 |
| server/lifecycleManager.ts | 对存储订单发起 capture / void / refund |
| facilitator/collect.ts | 初次收款的验证、模拟、提交和对账 |
| facilitator/lifecycle.ts | 后续生命周期的验证与提交 |
| nonce.ts、lifecyclePayload.ts | 支付身份、nonce 及商家操作授权数据 |

client、server、facilitator 都有名为 AuthCaptureEvmScheme 的类，但各自实现不同接口，导入时要选对入口。它们最终接入同一套已有的 Commerce Payments 合约，并不是三套链上 Escrow。

核对 [#3203](https://github.com/x402-foundation/x402/pull/3203) 的提交 [28376d6](https://github.com/x402-foundation/x402/commit/28376d643a6d9492e4a6cbfa5199376b90eb89dc)后可见，164 个变更文件中没有生产 Solidity 合约变更。这次主要新增或完善了 client / server / facilitator 的授权、结算和生命周期管理。abi.ts 描述的是已有合约的接口，不是新的合约实现。

新增的 Solidity 只有三个集成测试 operator：ForwardingOperator 转发 authorize / charge；NoopOperator 调用不 revert 却不收款，用于识别假成功；GasWastingOperator 消耗过多 gas，用于检查调用限制。

官方[测试说明](https://github.com/x402-foundation/x402/blob/faa1c694c66a3732aaabbce93bdae140e521a67d/typescript/packages/mechanisms/evm/test/contracts/auth-capture/README.md)限定它们用于集成测试，不能当作生产 operator 模板。

## 2 HTTP 接口与操作分派

客户端首次请求业务 API，服务端返回 402 和 PAYMENT-REQUIRED；客户端签名后携 PAYMENT-SIGNATURE 重试。服务端与 facilitator 使用以下接口：

| 接口 | 请求 / 返回重点 | 是否移动资金 |
| --- | --- | --- |
| GET /supported | 支持的 scheme / network、operator 及费用等配置 | 否 |
| POST /verify | 请求体包含 paymentPayload、paymentRequirements；返回验证结果 | 否 |
| POST /settle | 使用同样两项请求对象，提交操作并返回交易结果 | 按实际操作决定 |

| payload 与付款条件 | 实际合约操作 |
| --- | --- |
| collect，无 payload.type，paymentFlow="escrow" | authorize |
| collect，无 payload.type，paymentFlow="authorization" | charge，服务端需补齐金额、费用和操作授权 |
| payload.type="capture" / "void" / "refund" | 对应生命周期函数 |

没有单独规定 /capture、/void、/refund HTTP 接口。/settle 成功也不一定表示商家已收钱：authorize 只是建立托管。/verify 不保证以后一定能收款，settle 会重新验证并模拟。

下图限定为 delegated、可代办生命周期的 sync escrow 路径；charge 和 custom 的分支见下文。

![sync escrow 的两次 settle](../assets/auth-capture/03-settle-sequence.png)

## 3 服务端选择路径与期限

源码：[async enhancePaymentRequirements(](https://github.com/x402-foundation/x402/blob/faa1c694c66a3732aaabbce93bdae140e521a67d/typescript/packages/mechanisms/evm/src/auth-capture/server/scheme.ts#L228)；[async enrichSettlementPayload(](https://github.com/x402-foundation/x402/blob/faa1c694c66a3732aaabbce93bdae140e521a67d/typescript/packages/mechanisms/evm/src/auth-capture/server/settlementHooks.ts#L80)；[private async persistCollect(](https://github.com/x402-foundation/x402/blob/faa1c694c66a3732aaabbce93bdae140e521a67d/typescript/packages/mechanisms/evm/src/auth-capture/server/settlementHooks.ts#L255)。

server.enhancePaymentRequirements 合并 facilitator 与商户配置，解析部署、期限和支付路径，并拒绝旧 autoCapture 字段。相对期限会在这里转成绝对期限；后续扣款必须沿用，不能拿新期限重建订单。

paymentFlow 由服务端业务路由的 extra 设置。默认值 escrow 让初次 collect 执行 authorize；设为 authorization 则执行 charge。captureMode 的 sync / deferred 只用于 escrow，authorization 不得设置。

客户端按选中的付款条件生成签名，不能另传一个 type="charge" 来改变路径。/escrow 与 /charge 只是示例路由名，并非协议接口。

settlementHooks 的 before-handler 不追加商户扣款签名。authorize 成功后，handleAfterSettle 保存完整 PaymentInfo、saltNonce、支付 key、收款交易和余额。

after-handler 为 sync escrow 构造 capture，为 authorization 路径补齐 charge。deferred escrow 则保留已托管结果，不在请求结束时扣款。cancel 会为可代办生命周期的 escrow 路径构造 void。

上述阶段依据 scheme hooks 及其测试说明，本文未展开全部 core HTTP middleware 的调度源码。操作由 SDK 发起，不能理解成合约到时会自动执行。

| extra 主要参数 | 对应意义 |
| --- | --- |
| captureAuthorizer | 链上 operator；delegated 通常从 /supported 获得 |
| receiverAuthorizer | 商家操作授权的签名地址；charge 和代办生命周期需要非零 |
| captureDeadline / refundDeadline | 对应 PaymentInfo.authorizationExpiry / refundExpiry |
| captureDeadlineSeconds / refundDeadlineSeconds | 服务端可配置的相对期限，由增强阶段转成绝对时间 |
| feeRecipient / minFeeBps / maxFeeBps | 费用地址和范围 |
| assetTransferMethod | eip3009（默认）或 permit2，决定配套 Collector |

SDK 支持相对期限不代表后续操作可以延期。订单形成后必须保留原始 PaymentInfo；charge 属于首次收款，仍受用户签名中的 preApprovalExpiry 限制。

## 4 客户端签什么，nonce 如何绑定条款

入口：[async createPaymentPayload(](https://github.com/x402-foundation/x402/blob/faa1c694c66a3732aaabbce93bdae140e521a67d/typescript/packages/mechanisms/evm/src/auth-capture/client/scheme.ts#L61)；地址承诺：[export function deriveBoundSalt(](https://github.com/x402-foundation/x402/blob/faa1c694c66a3732aaabbce93bdae140e521a67d/typescript/packages/mechanisms/evm/src/auth-capture/nonce.ts#L381)。

createPaymentPayload 先校验协议版本与必填 extra，解析网络和部署，再将 requirements 转为字段名称与 Solidity 一致的 PaymentInfo。preApprovalExpiry 等于当前时间加 maxTimeoutSeconds。facilitator 后续重建订单时，要从签名的 validBefore/deadline 读取这个期限，不能按新的当前时间重算。

客户端生成随机 saltNonce。receiverAuthorizer 或 policy 非零时，salt 是带 SALT_BINDING_TYPEHASH 的地址承诺；否则 salt 就是随机值，不附加 saltNonce。绑定启用时两者都要保留：salt 进入链上条款，saltNonce 用来验证承诺。

| 签名路径 | EIP-712 domain | 签名的收款授权 |
| --- | --- | --- |
| ERC-3009 | token 合约，name/version 来自 token 域参数 | ReceiveWithAuthorization，to 为匹配部署的 ERC3009 Collector |
| Permit2 | canonical Permit2 合约 | PermitTransferFrom，spender 为匹配部署的 Permit2 Collector |

用户这次付款签名同意的是收款条款，不需要为之后的每次 capture 再签一次。后续扣款由 operator 执行，费用和时间等仍受条款限制。

### 支付哈希与签名 nonce

源码：SDK [function hashPaymentInfo(](https://github.com/x402-foundation/x402/blob/faa1c694c66a3732aaabbce93bdae140e521a67d/typescript/packages/mechanisms/evm/src/auth-capture/nonce.ts#L45)，合约 [function getHash(](https://github.com/base/commerce-payments/blob/b748fdd7a830a655a19a530edcf2a94b9dc7d25f/src/AuthCaptureEscrow.sol#L383)，Collector [function _getHashPayerAgnostic(](https://github.com/base/commerce-payments/blob/b748fdd7a830a655a19a530edcf2a94b9dc7d25f/src/collectors/TokenCollector.sol#L70)。

```text
H(info) = keccak256(abi.encode(
  chainId,
  escrowAddress,
  keccak256(abi.encode(PAYMENT_INFO_TYPEHASH, info))
))

paymentInfoHash = H(真实 payer 的 PaymentInfo)
signatureNonce  = H(payer 置零后的 PaymentInfo)
```

客户端 hashPaymentInfo 使用 encodeAbiParameters；合约 getHash 使用 abi.encode。字段类型、顺序、typehash 和外层 chainId、escrow 地址必须一致。这里是自定义支付标识的哈希规则，不能直接替换成带 0x1901 前缀的通用 EIP-712 digest。

token nonce 中的 payer 虽然置零，实际付款人仍由 ERC-3009 的 from 或 Permit2 的 owner 及其签名绑定。Collector 也会将传入 PaymentInfo 的 payer 置零后重算 nonce。因此，两份签名即使用了相同的 nonce 值，也不能跨付款人使用。每次付款的随机 salt 用来区分不同支付。

receiver、operator、金额上限、期限和费用都绑定在 nonce 中。即使拿到了 token 签名，修改这些字段后也无法通过 canonical Collector 的授权验证。

## 5 Facilitator 验证与合约目标选择

分派：[async verify(](https://github.com/x402-foundation/x402/blob/faa1c694c66a3732aaabbce93bdae140e521a67d/typescript/packages/mechanisms/evm/src/auth-capture/facilitator/scheme.ts#L169)；collect 验证：[export async function verifyCollect(](https://github.com/x402-foundation/x402/blob/faa1c694c66a3732aaabbce93bdae140e521a67d/typescript/packages/mechanisms/evm/src/auth-capture/facilitator/collect.ts#L177)；目标选择：[export function resolveSettleTarget](https://github.com/x402-foundation/x402/blob/faa1c694c66a3732aaabbce93bdae140e521a67d/typescript/packages/mechanisms/evm/src/auth-capture/extra.ts#L329)；operator 准入：[export function validateOperator](https://github.com/x402-foundation/x402/blob/faa1c694c66a3732aaabbce93bdae140e521a67d/typescript/packages/mechanisms/evm/src/auth-capture/extra.ts#L261)。

verify/settle 按 payload.type 区分 collect 与 capture/void/refund。verifyCollect 主要检查：

- scheme、network、extra、operator 与收款方式匹配。
- deadline 次序和剩余有效期；实现预留 6 秒安全余量。
- ERC-3009 to 或 Permit2 spender 与所选部署 Collector 一致。
- 付款签名、金额上限、重建 PaymentInfo 后的 nonce。
- 启用绑定时的 saltNonce 与 salt；charge completion 的金额、费用与商户授权。
- 模拟实际调用是否成功。

智能钱包的签名不能只靠 recoverAddress 验证。ERC-1271 验证失败后，不能自动回退为 ECDSA 成功。未部署的 ERC-6492 钱包需要允许的准备目标，并通过 collect 模拟完成验证。预验证时可以取出内层签名；提交时仍要保留 ERC-6492 wrapper，让链上调用完成部署准备。

delegated 模式要求 operator 是 facilitator 控制的提交地址，调用目标为 Escrow。custom 模式调用 operator 合约，后续生命周期不由此 SDK relay。本文使用的实现仍不接受 policy 类型的 operator。

| operator 配置 | 官方 relay 范围 | escrow 路由的 captureMode |
| --- | --- | --- |
| delegated，非零 receiverAuthorizer | authorize / charge 及 capture / void / refund；退款另受资金开关限制 | sync 或 deferred |
| delegated，无 receiverAuthorizer 或为零 | 只代办 authorize，后续由 operator 自行处理 | 必须 deferred |
| custom | 只代办 collect（authorize / charge），生命周期走自定义 operator 接口 | 必须 deferred |

charge 在两种 operator 模式下都需要非零 receiverAuthorizer。服务端自管签名地址时，要配置匹配的 receiverAuthorizerSigner；若委托 facilitator 签名，还需下文的调用者认证与订单绑定。

## 6 Custom operator 的模拟与结果核对

源码：[async function simulateCollect(](https://github.com/x402-foundation/x402/blob/faa1c694c66a3732aaabbce93bdae140e521a67d/typescript/packages/mechanisms/evm/src/auth-capture/facilitator/collect.ts#L1093)；[export async function settleCollect(](https://github.com/x402-foundation/x402/blob/faa1c694c66a3732aaabbce93bdae140e521a67d/typescript/packages/mechanisms/evm/src/auth-capture/facilitator/collect.ts#L765)。

custom operator 收到调用后，可能什么都没做。因此 simulateCollect 要求使用 simulateCalls，批量观察调用前后的状态，核对 Escrow 事件、paymentState 和余额变化，并为 operator 调用设置 gas 上限。

广播后，awaitCollectSettlement 还会核对所需事件和状态；custom 路径会额外核对余额。交易 receipt 为 success 只能说明交易执行成功，还需要确认约定的收款确实完成。

这些检查用于验证外围合约的收款行为，不能证明任意自定义仲裁逻辑都已由基础 Escrow 验证正确。

## 7 商家操作签名与委托身份

源码：[export async function buildCaptureFields](https://github.com/x402-foundation/x402/blob/faa1c694c66a3732aaabbce93bdae140e521a67d/typescript/packages/mechanisms/evm/src/auth-capture/lifecyclePayload.ts#L100)；[async function verifyCapturePayload(](https://github.com/x402-foundation/x402/blob/faa1c694c66a3732aaabbce93bdae140e521a67d/typescript/packages/mechanisms/evm/src/auth-capture/facilitator/lifecycle.ts#L864)；[async function signDelegatedLifecycle(](https://github.com/x402-foundation/x402/blob/faa1c694c66a3732aaabbce93bdae140e521a67d/typescript/packages/mechanisms/evm/src/auth-capture/facilitator/lifecycle.ts#L258)；[export async function bindThenBroadcast](https://github.com/x402-foundation/x402/blob/faa1c694c66a3732aaabbce93bdae140e521a67d/typescript/packages/mechanisms/evm/src/auth-capture/facilitator/delegatedAuth.ts#L198)。

buildCaptureFields 将支付 key、金额、费用、预期 capturable/refundable 余额纳入商户操作签名。verifyCapturePayload 验证签名、读取链上余额并与预期值比对，再模拟 capture。余额变化后，旧操作通常无法再次通过同一预期状态检查。

基础 Escrow.capture 的参数没有 authorizerSignature，也没有 expectedBalances，只检查 operator、金额、费用和期限。因此，商户是否同意以及操作是否符合预期余额，主要由 facilitator 校验。读链与写链之间仍有并发时间窗口，不能把它理解成链上的原子比较交换。

源码也支持由 facilitator 代任 receiver authorizer。这个分支仍要认证调用者：先 resolveCallerIdentity，再在收款时 bind 调用者与支付身份。后续生命周期只有匹配同一绑定身份，facilitator 才能生成操作签名。

bindThenBroadcast 在广播前建立绑定，之后是否撤销，要看广播结果。结果不明时，不能假设交易从未发生。

## 8 退款如何接入

### 官方 SDK 默认如何处理 refund

源码：[refundFunding 配置](https://github.com/x402-foundation/x402/blob/faa1c694c66a3732aaabbce93bdae140e521a67d/typescript/packages/mechanisms/evm/src/auth-capture/types.ts#L202-L212)；[未开启时拒绝](https://github.com/x402-foundation/x402/blob/faa1c694c66a3732aaabbce93bdae140e521a67d/typescript/packages/mechanisms/evm/src/auth-capture/facilitator/lifecycle.ts#L142-L148)；[官方示例默认关闭](https://github.com/x402-foundation/x402/blob/faa1c694c66a3732aaabbce93bdae140e521a67d/examples/typescript/facilitator/auth-capture/index.ts#L133-L135)；[LifecycleManager.refund](https://github.com/x402-foundation/x402/blob/faa1c694c66a3732aaabbce93bdae140e521a67d/typescript/packages/mechanisms/evm/src/auth-capture/server/lifecycleManager.ts#L115-L139)。

官方示例设置 refundFunding=false。delegated 退款未开启时，SDK 返回 invalid_auth_capture_evm_refund_funding_unavailable。退款要花 operator 自己的钱，所以即使有商户操作签名，也仍需商户与 facilitator 另行约定资金如何承担。

设为 true 只会开放退款处理，不会自动筹资、approve 或建立商户备付金账本。轮换提交地址时，每个旧订单对应的 operator 都需要资金和 allowance。

资金安排的协议要求见官方 [Refund funding](https://github.com/x402-foundation/x402/blob/faa1c694c66a3732aaabbce93bdae140e521a67d/specs/schemes/auth-capture/scheme_auth_capture_evm.md#refund-funding)。

有持久化订单记录后，服务端可以调用 lifecycleManager.refund(paymentInfoHash, {amount: "2000000"}) 退 2 USDC（6 位小数）。SDK 构建 type="refund" 的 payload，经同一个 /settle 提交。商户自签模式提供操作签名；委托签名模式由 facilitator 根据已认证调用者与支付的绑定关系签名。

随后检查 refundExpiry、链上两项预期余额和退款额度，模拟通过后，以原 operator 调用 Escrow。成功后，服务端更新本地可退额度。预期余额由 facilitator 校验，基础 Escrow 没有原子比较这两项预期余额的参数。

退款的额度、资金流和费用处理见[合约 refund](auth-capture-solidity-walkthrough.md#13-refund额度减少新资金再进来)。custom operator 的退款不由官方 facilitator relay。

合约、SDK、测试源码存在，不能当作生产使用证据；示例默认关闭，也不能推出全部部署未开启或无人使用。本次没有核实生产退款交易及用量。

## 9 Pending 重试、剩余款释放与存储

源码：[export async function settleCollect(](https://github.com/x402-foundation/x402/blob/faa1c694c66a3732aaabbce93bdae140e521a67d/typescript/packages/mechanisms/evm/src/auth-capture/facilitator/collect.ts#L765)；[async function settleVerifiedLifecycle(](https://github.com/x402-foundation/x402/blob/faa1c694c66a3732aaabbce93bdae140e521a67d/typescript/packages/mechanisms/evm/src/auth-capture/facilitator/lifecycle.ts#L582)；[async capture(](https://github.com/x402-foundation/x402/blob/faa1c694c66a3732aaabbce93bdae140e521a67d/typescript/packages/mechanisms/evm/src/auth-capture/server/lifecycleManager.ts#L43)；[export interface AuthorizedPaymentStorage](https://github.com/x402-foundation/x402/blob/faa1c694c66a3732aaabbce93bdae140e521a67d/typescript/packages/mechanisms/evm/src/auth-capture/server/storage.ts#L64)。

settleCollect 先查 pending 交易。缓存命中后，会继续等待原交易并对账，避免直接重广播。collect key 使用付款签名；若生命周期签名由 facilitator 动态生成，pending key 则按操作内容派生，避免同一操作重签后落到不同 key。pending 不等于已确认失败，不能盲目生成新 salt 重新付款。

capture 带有释放剩余款的意图时，settleVerifiedLifecycle 会先等 capture 成功，再单独 submit void。第二笔操作按 best effort 处理：即使 void 失败，仍返回 capture 成功，剩余款需要后续 void 或到期 reclaim。

本地记录也可能与链上结果不同。LifecycleManager.capture 成功后按 opts.voidRemainder 更新本地余额；sync hooks 则按是否存在 void 签名判断清零意图。因此，本地 capturable=0 不能证明第二笔 void 已确认，还要核对两笔交易和真实链上 paymentState。这是从源码看到的记录与执行差异，本文没有运行故障注入测试。

AuthorizedPaymentStorage.update 要求原子条件修改。默认内存实现的锁只在一个 JS runtime 内生效，无法协调多个实例；存储更新是原子的，也不代表整个“读记录—发链上交易—更新记录”过程都被锁住。

## 10 SDK 测试入口与阅读边界

以下为本次检查的测试源码入口，没有执行测试。合约测试集中见[Solidity 走读](auth-capture-solidity-walkthrough.md#17-读完后去看哪些测试)。

| 官方测试源码 | 可核对的断言 |
| --- | --- |
| [pendingSettlement.test.ts](https://github.com/x402-foundation/x402/blob/faa1c694c66a3732aaabbce93bdae140e521a67d/typescript/packages/mechanisms/evm/test/unit/auth-capture/pendingSettlement.test.ts) | receipt 超时返回 pending，缓存命中不重广播 |
| [settlementHooks.test.ts](https://github.com/x402-foundation/x402/blob/faa1c694c66a3732aaabbce93bdae140e521a67d/typescript/packages/mechanisms/evm/test/unit/auth-capture/settlementHooks.test.ts) | 委托签名 enrichment、deferred 跳过、失败不保存记录 |
| [lifecycleFacilitator.test.ts](https://github.com/x402-foundation/x402/blob/faa1c694c66a3732aaabbce93bdae140e521a67d/typescript/packages/mechanisms/evm/test/unit/auth-capture/lifecycleFacilitator.test.ts) | 拒绝 PaymentInfo 不匹配、salt 绑定错误、错误费用字段 |

合约检查金额、费用、期限和操作人；SDK 处理签名、身份绑定、模拟和重试。业务系统还要负责判断交付、审批退款、准备资金和对账。TRON 的适配范围见下一节。

## 11 TRON 适配

以下是待执行的移植范围，尚未完成编译、合约测试或链上部署验证。建议首版限定为 **USDT + Permit2 + 单一 delegated operator**。TVM 兼容 Solidity 有助于复用代码，但不能据此认为现有 EVM 部署可直接使用，或只复制 Escrow 就能接入。

![TRON 合约与 SDK 适配范围](../assets/auth-capture/07-tron-port.png)

### 11.1 要移植什么

| 组件 | 首版处理 | 不能省略的依赖 |
| --- | --- | --- |
| AuthCaptureEscrow | 移植并部署六种操作及账本 | 重入锁、Collector 类型、入金核对 |
| TokenStore | 部署模板、按 operator 创建实例 | CREATE2 / clone 的预测与实际地址一致 |
| Permit2PaymentCollector | 从 payer 收款进入 TokenStore | 目标 Permit2 接口、签名域和 token allowance |
| OperatorRefundCollector | 从 operator 收取退款资金 | TRC-20 transferFrom、余额和给 Collector 的 allowance |
| TokenCollector 等基类 | 随具体合约编译适配 | 不额外部署一个抽象基类中转地址 |
| SDK / facilitator | 形成付款条件、签名、交易提交与状态恢复 | 原始 PaymentInfo、部署配置、持久化状态 |

### 11.2 USDT 为什么走 Permit2

现有 TRON SDK 的[资产配置说明](https://github.com/BofAI/x402/blob/main/typescript/packages/mechanisms/tron/src/shared/defaultAssets.ts)为 USDT 选择 Permit2，因为它不支持所需的 3009 风格签名转账。Collector 只能使用代币已有的能力；写一个名为 TRC3009PaymentCollector 的合约，不会改变现有 USDT 的接口。

等目标代币确实支持相应签名收款，再增加 3009 路径。还要核对官方 ERC3009 Collector 的 receiveWithAuthorization，与现有 TRON exact 的 transferWithAuthorization 在接口、签名类型和调用约束上有哪些差别。

USDT 的预期流程是：

```text
首次准备：用户 approve USDT 给 Permit2
每笔支付：用户签名 → Escrow → PaymentCollector → Permit2
资金移动：payer → TokenStore
后续付款：Escrow → TokenStore → USDT.transfer → 商家 / 费用方
```

首次 allowance 和每笔付款签名是两个条件。还需与客户端一起验证钱包能否完成相应的结构化签名，以及失败或到期后怎样重试。

现有 SDK 的 [constants.ts](https://github.com/BofAI/x402/blob/main/typescript/packages/mechanisms/tron/src/constants.ts)登记了 Permit2 和 exact / upto Proxy 地址，但这些地址的链上字节码与接口尚未核实。需要确认目标 Permit2 的 permitTransferFrom、签名域、nonce 和地址处理；exact / upto Proxy 使用 witness，不能直接当作 auth-capture Collector。token 工具、注册表和交易执行适配也要核对 TRC-20 ABI、decimals、地址、allowance、模拟、回执及 pending 支持。

### 11.3 三处重点

**TokenStore 地址预测。** 资金可以先进入预测地址，首次支出时才部署实例。TRON CREATE2 使用 0x41 推导前缀，EVM 使用 0xff；需要逐项核对 LibClone 创建代码、salt、部署地址和 TVM 规则，不能只改 SDK 地址格式，否则资金可能无法按预期转出。依据见 [TRON TVM 与 EVM 差异](https://developers.tron.network/docs/tvm-vs-evm)。

**签名与哈希。** 区分链上 20 字节地址与外部 Base58 / 41 前缀地址。合约与 SDK 的 chainId、Escrow、字段顺序和哈希规则必须一致：账本使用真实 payer，付款 nonce 使用 payer 置零后的条款哈希，不能用 exact witness 替换。Token、Permit2 和商家操作签名各自使用正确的域、类型和表示；后续 capture / refund 保留原条款和 saltNonce，重试不能另造期限或 salt。形成过程见[第 4 节](#4-客户端签什么nonce-如何绑定条款)。

**执行与恢复。** 原合约使用 Solidity ^0.8.28、Solady clone 和 transient storage 重入锁，要按目标网络实际升级配置核对编译产物和 opcode，不能笼统认为 TVM 完全兼容或不支持 transient storage。ERC-6492 / Multicall3 也要核对；限定钱包范围时，SDK 应明确准入并拒绝未支持路径。facilitator 还要处理 Energy / 费用估计、广播、回执、事件与余额对账，以及 pending 恢复。结果不明时先查原交易；refund 仍需资金协议、operator 余额和 allowance。

### 11.4 验证顺序

1. 核对目标 Permit2 与 USDT 的实际接口、签名和 allowance。
2. 在目标 TVM 环境验证编译、CREATE2 预测、clone 和先入金后部署。
3. 跑通 authorize → capture → void / reclaim，核对六种操作的权限、期限与账本。
4. 跑通 charge 与部分退款，核对分账原子性、失败回滚和退款资金来源。
5. 接入 SDK 的支付条件、用户签名和商家授权，验证原始条款持久化。
6. 验证超时、重复请求、进程重启、回执不明、余额或 allowance 不足的恢复行为。

以上工作尚待执行，不代表测试已经通过。

[返回分享主稿](auth-capture-contract-analysis.md) · [查看合约实现](auth-capture-solidity-walkthrough.md) · [来源与验证范围](auth-capture-contract-analysis.md#9-源码版本与验证范围)
