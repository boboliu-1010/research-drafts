# auth-capture 合约源码走读

> 未经评审的研究草稿。基于静态源码阅读，未执行 Foundry 测试或链上交易。

更新：2026 年 10 月 20 日。固定源码为 base/commerce-payments 的 `b748fdd7a830a655a19a530edcf2a94b9dc7d25f`，以 v1.1 为准。下面引用源码中的关键语句，省略部分声明、事件和检查；流程块是阅读笔记，不是可部署合约。

贯穿例子：用户同意上限 10 USDC，任务完成后实际消费 6，费用 1%。金额说明用 USDC；真实参数需乘 10⁶。

## 1 先打开哪些文件

| 阅读顺序 | 官方源码 | 要回答的问题 |
| --- | --- | --- |
| 1 | [AuthCaptureEscrow.sol](https://github.com/base/commerce-payments/blob/b748fdd7a830a655a19a530edcf2a94b9dc7d25f/src/AuthCaptureEscrow.sol) | 如何识别订单，谁能收款、扣款、退款 |
| 2 | [TokenStore.sol](https://github.com/base/commerce-payments/blob/b748fdd7a830a655a19a530edcf2a94b9dc7d25f/src/TokenStore.sol) | 钱存在哪个地址，谁能指令转出 |
| 3 | [TokenCollector.sol](https://github.com/base/commerce-payments/blob/b748fdd7a830a655a19a530edcf2a94b9dc7d25f/src/collectors/TokenCollector.sol) | 收款入口权限和 nonce 如何统一 |
| 4 | [ERC3009PaymentCollector.sol](https://github.com/base/commerce-payments/blob/b748fdd7a830a655a19a530edcf2a94b9dc7d25f/src/collectors/ERC3009PaymentCollector.sol) | USDC 等支持 ERC-3009 的 token 怎样验签收款 |
| 5 | [Permit2PaymentCollector.sol](https://github.com/base/commerce-payments/blob/b748fdd7a830a655a19a530edcf2a94b9dc7d25f/src/collectors/Permit2PaymentCollector.sol) | 如何通过 Permit2 收款 |
| 6 | [OperatorRefundCollector.sol](https://github.com/base/commerce-payments/blob/b748fdd7a830a655a19a530edcf2a94b9dc7d25f/src/collectors/OperatorRefundCollector.sol) | 退款实际扣谁的钱 |

先记住三个职责：**Escrow 管条款与订单账，Collector 负责从外部收钱，TokenStore 按 Escrow 指令付款。** ERC6492SignatureHandler 是两个付款 Collector 共用的签名准备辅助类，后文单独说明。

## 2 PaymentInfo：用户同意的固定条款

位置：[PaymentInfo](https://github.com/base/commerce-payments/blob/b748fdd7a830a655a19a530edcf2a94b9dc7d25f/src/AuthCaptureEscrow.sol#L27)。

| 字段 | 代码里的作用 | 例子 |
| --- | --- | --- |
| operator | authorize、charge、capture、void、refund 的唯一调用者 | facilitator 的提交地址，也可以是自定义 operator 合约 |
| payer | 付款人、退款接收人、reclaim 的调用者 | 用户钱包 |
| receiver | 扣款后货款接收人 | 商家钱包 |
| token | 本订单代币合约 | USDC |
| maxAmount | 首次收款上限 | 10 USDC |
| preApprovalExpiry | authorize / charge 首次收款的截止时间 | 付款签名有效窗口 |
| authorizationExpiry | capture 截止、reclaim 开始时间 | 订单扣款窗口 |
| refundExpiry | refund 截止时间 | 售后退款窗口 |
| minFeeBps / maxFeeBps | 限制每次扣款的费用 | 都为 100 时固定 1% |
| feeReceiver | 非零时固定费用地址；为零时允许调用时选择 | 平台或 facilitator 的费用地址 |
| salt | 让相同商家、金额等条件的不同购买有不同身份 | 每笔购买独立生成 |

后续调用都要传入这份原始条款。合约没有“修改订单收款人或延期”的入口；改条款会改变支付哈希，无法操作原来的余额。

## 3 PaymentState：链上只存三项状态

位置：[PaymentState 与 paymentState](https://github.com/base/commerce-payments/blob/b748fdd7a830a655a19a530edcf2a94b9dc7d25f/src/AuthCaptureEscrow.sol#L55)。

```solidity
struct PaymentState {
    bool hasCollectedPayment;
    uint120 capturableAmount;
    uint120 refundableAmount;
}
```

- `hasCollectedPayment`：这笔支付是否已经收过钱。authorize 或 charge 后为 true，退完钱也不复位。
- `capturableAmount`：这笔订单还有多少托管款可以付给商家。
- `refundableAmount`：已经付出去的金额中，还允许退多少。它是额度，不是另存的准备金。

账本按 `paymentState[paymentInfoHash]` 存储。完整条款由调用者提供，合约重算哈希后定位三项状态。

## 4 getHash：订单编号怎样绑定条款

位置：[getHash](https://github.com/base/commerce-payments/blob/b748fdd7a830a655a19a530edcf2a94b9dc7d25f/src/AuthCaptureEscrow.sol#L383)。

```solidity
bytes32 paymentInfoHash = keccak256(abi.encode(PAYMENT_INFO_TYPEHASH, paymentInfo));
return keccak256(abi.encode(block.chainid, address(this), paymentInfoHash));
```

第一步把全部条款编码成哈希，第二步再加入当前链和 Escrow 地址。所以同样条款换一条链、换一个 Escrow，也会得到不同支付编号。

这不是直接调用通用 EIP-712 digest 函数；实现按上面的 `abi.encode` 规则计算。SDK 必须使用同样的字段顺序、类型和外层编码。

付款签名如何承诺这些条款？canonical Collector 把 PaymentInfo 的 payer 临时置零，调用这个 getHash，将结果放进 ERC-3009 / Permit2 的 nonce。真实付款人仍由 token 签名中的 from / owner 绑定。修改 operator、receiver、费用或期限后，nonce 也会变化，原签名不能照用。

注意区分：**订单账本哈希带真实 payer，付款签名的 nonce 使用 payer 置零后的哈希。**

## 5 入口修饰器：谁能做、金额是否合法

位置：[onlySender / validAmount](https://github.com/base/commerce-payments/blob/b748fdd7a830a655a19a530edcf2a94b9dc7d25f/src/AuthCaptureEscrow.sol#L170)。

`onlySender(paymentInfo.operator)` 要求当前调用者就是原 operator；reclaim 则使用 payer。`validAmount(amount)` 要求金额大于零、不超过 uint120 上限，后面转成 uint120 才不会截断。

六个资金操作均有 `nonReentrant`。它们先检查与更新订单状态，再进行外部代币调用；外部调用失败时，前面的写账和事件也一起回滚。

基础 Escrow 不检查业务是否交付，也没有接收商家的 `authorizerSignature` 参数。默认 delegated 模式中，商家的操作授权由 facilitator 校验；合约只按 operator 和固定条款执行。

## 6 authorize：先写账，再验证钱真的到账

位置：[authorize](https://github.com/base/commerce-payments/blob/b748fdd7a830a655a19a530edcf2a94b9dc7d25f/src/AuthCaptureEscrow.sol#L236)。按执行顺序看：

| 顺序 | 代码动作 | 白话解释 |
| --- | --- | --- |
| 1 | onlySender、validAmount、_validatePayment | 调用者正确、金额正确、还在首次收款窗口内 |
| 2 | getHash；检查 hasCollectedPayment | 找到这笔订单，禁止第二次收款 |
| 3 | 写 true、capturable=amount、refundable=0 | 建立托管账本，尚未向商家付款 |
| 4 | _collectTokens(..., CollectorType.Payment) | 通过付款 Collector 收入足额代币 |

`_validatePayment` 还要求 amount≤maxAmount、preApprovalExpiry≤authorizationExpiry≤refundExpiry，以及 minFeeBps≤maxFeeBps≤10000。它检查的是现在是否早于 preApprovalExpiry，而不只是三个期限的顺序。

例子成功后：hasCollected=true，capturable=10，refundable=0，10 USDC 已进入 operator 对应的 TokenStore。

合约允许 authorize 金额小于上限；本次阅读的 x402 authorize 路径选择收完整上限。无论收多少，这个支付身份都不能再用来补款。

## 7 _collectTokens：Collector 说收到了还不够

位置：[_collectTokens](https://github.com/base/commerce-payments/blob/b748fdd7a830a655a19a530edcf2a94b9dc7d25f/src/AuthCaptureEscrow.sol#L408)。

```text
检查 collectorType 是本次要求的 Payment 或 Refund
→ 找到本 operator 的 TokenStore
→ 读取 TokenStore 的 token 余额 before
→ 调 Collector.collectTokens(...)
→ 读取余额 after
→ 要求 after == before + amount
```

因此 Collector 返回成功，并不自动意味着收款完成；实际余额净增也必须等于 amount。少到账、多到账都会被这项检查拒绝。带转账扣费的 token 也不能假定兼容。

这里校验的是类型和实收入金，不是硬编码 canonical Collector 地址白名单。x402 SDK 还会按部署配置选择、验证相应 Collector。

## 8 两种 Payment Collector 的调用链

### ERC-3009：签名金额固定为上限

位置：[ERC3009PaymentCollector._collectTokens](https://github.com/base/commerce-payments/blob/b748fdd7a830a655a19a530edcf2a94b9dc7d25f/src/collectors/ERC3009PaymentCollector.sol#L31)。

```text
Operator → Escrow.authorize / charge
→ ERC3009PaymentCollector.collectTokens
→ token.receiveWithAuthorization：payer → Collector，金额 maxAmount
→ 如果 maxAmount > amount，Collector 将差额转回 payer
→ Collector 将本次 amount 转给 TokenStore
```

其中 to 是 Collector 自身，validBefore 是 preApprovalExpiry，nonce 是 payer 置零后的订单哈希，collectorData 提供付款签名。真正执行 token 授权验证的是 token 合约；Escrow 不自行恢复用户签名地址。

authorize 10 时，Collector 收 10、存 10；charge 6 时，Collector 收 10、退 4、存 6，全部在同一交易。因此后者虽然净付 6，执行时钱包仍需有 10。

### Permit2：签上限，只请求本次金额

位置：[Permit2PaymentCollector._collectTokens](https://github.com/base/commerce-payments/blob/b748fdd7a830a655a19a530edcf2a94b9dc7d25f/src/collectors/Permit2PaymentCollector.sol#L37)。

```text
Operator → Escrow.authorize / charge
→ Permit2PaymentCollector.collectTokens
→ Permit2.permitTransferFrom
→ token.transferFrom：payer → TokenStore，金额 requestedAmount
```

permitted.amount 为 maxAmount，requestedAmount 为实际 amount，nonce 和 deadline 同样绑定订单。spender 是付款 Collector；token 的底层 allowance 则需要给 Permit2。签名授权和 ERC-20 allowance 是两个条件，不能只准备签名。

TokenCollector 的公共入口只接受它构造时指定的 Escrow。两个付款 Collector 都继承这个入口，再分别实现自己的内部 _collectTokens。

## 9 capture：把可扣余额转换为可退额度

位置：[capture](https://github.com/base/commerce-payments/blob/b748fdd7a830a655a19a530edcf2a94b9dc7d25f/src/AuthCaptureEscrow.sol#L267)。

检查顺序是：入口权限和金额 → _validateFee → now<authorizationExpiry → capturableAmount≥amount。随后执行：

```solidity
state.capturableAmount -= uint120(amount);
state.refundableAmount += uint120(amount);
paymentState[paymentInfoHash] = state;
```

例子 capture(6) 后，可扣余额 10→4，可退额度 0→6。这里并没有再从 payer 收钱，因此没有 Collector 参数。

![capture 的逐层调用及回滚边界](../assets/auth-capture/10-capture-internal-split.png)

`_distributeTokens` 先转 feeAmount 给 feeReceiver，再转 amount−feeAmount 给 receiver。amount 包含费用；6 USDC、1% 费用时对应 0.06 和 5.94。

内部函数 _distributeTokens / _sendTokens 不改变 msg.sender，仍是 operator。跨合约调用 TokenStore.sendTokens 后，TokenStore 看到的 msg.sender 是 Escrow；它再调 token.transfer，token 看到的 msg.sender 才是 TokenStore。

| 当前执行位置 | msg.sender | 用它检查什么 |
| --- | --- | --- |
| Escrow.capture 及其内部函数 | operator | 是否有权操作本订单；选哪个 TokenStore |
| TokenStore.sendTokens | Escrow | 是否为固定的支出指令来源 |
| token.transfer | TokenStore | 减少哪个地址的代币余额 |

两次转账有先后顺序，但共享一次交易的成功或失败。后面的商家转账失败，前面的费用转账、账本和本次事件一起回滚。capture 可以分多次执行，但累计不能超过剩余托管额。

## 10 _validateFee：绝对金额受费率范围约束

位置：[_validateFee](https://github.com/base/commerce-payments/blob/b748fdd7a830a655a19a530edcf2a94b9dc7d25f/src/AuthCaptureEscrow.sol#L511)。

```text
minFee = floor(amount × minFeeBps / 10000)
maxFee = floor(amount × maxFeeBps / 10000)
要求 minFee ≤ feeAmount ≤ maxFee
```

v1.1 接收绝对 feeAmount，不是在 capture 内自动选一个费率。原条款费率上下限都为 100，本次总额 6，则费用只能是 0.06。费用非零时接收地址不能为零；条款 feeReceiver 非零时，调用地址必须与之相同。

费用为零会跳过费用转账。没有额外写死的协议费；gas 由交易发送者或代付方另付。整数取整也意味着分多次小额扣款的费用不一定等于一次扣款的费用。

## 11 charge：收钱和分账合并在一个入口

位置：[charge](https://github.com/base/commerce-payments/blob/b748fdd7a830a655a19a530edcf2a94b9dc7d25f/src/AuthCaptureEscrow.sol#L200)。

按源码执行顺序：

```text
检查调用者、金额、_validatePayment 和 _validateFee
→ 拒绝 hasCollectedPayment=true
→ 写入 hasCollected=true、capturable=0、refundable=amount
→ _collectTokens(...Payment)：把本次 amount 收入 TokenStore
→ _distributeTokens：立即分账
```

上限 10、charge 6，净支出和退款额度都是 6，没有持续保留的托管余额。它同样经过 TokenStore，只是同交易内收进来又分出去。无需随后 void；失败整笔回滚，也无需 void。

**charge 仍是首次收款，受 preApprovalExpiry 限制。** 即使 authorizationExpiry 还没到，付款签名的首次收款窗口过了，也不能执行 charge。SDK 若在业务完成后收款，必须为业务耗时留出有效窗口。

不能跳过 authorize 直接 capture，因为 capture 只能花已有托管款；charge 则提供当场收款能力。同一订单 authorize 和 charge 二选一，任何一种成功后都不能再次收款。

## 12 void 与 reclaim：清空尚未结算的余额

位置：[void](https://github.com/base/commerce-payments/blob/b748fdd7a830a655a19a530edcf2a94b9dc7d25f/src/AuthCaptureEscrow.sol#L304)、[reclaim](https://github.com/base/commerce-payments/blob/b748fdd7a830a655a19a530edcf2a94b9dc7d25f/src/AuthCaptureEscrow.sol#L323)。

两者都读取全部 capturableAmount，要求大于零，将其清零，再从 TokenStore 退给原 payer。它们没有部分退还金额参数，不改已有 refundableAmount，也不重置 hasCollectedPayment。

| 条件 | void | reclaim |
| --- | --- | --- |
| 调用者 | operator | payer |
| 时间检查 | 函数本身没有独立时间限制 | now≥authorizationExpiry |
| 返回哪笔钱 | 全部剩余托管款 | 全部剩余托管款 |

例子 capture 6 后，void 将剩余 4 退给用户。operator 不执行时，用户可以在到期后自行 reclaim 4；到期不会自动触发交易。授权截止时刻 capture 已失效，reclaim 则开始可用。

void 不能作废一个尚未收款的 token 签名，因为此时 capturableAmount=0，函数直接拒绝。已经付给商家的 6 也不能通过这两个函数追回。

## 13 refund：额度减少，新资金再进来

位置：[refund](https://github.com/base/commerce-payments/blob/b748fdd7a830a655a19a530edcf2a94b9dc7d25f/src/AuthCaptureEscrow.sol#L351)。

```text
检查 operator、金额、now<refundExpiry、amount≤refundableAmount
→ refundableAmount 减去本次退款
→ _collectTokens(...Refund)：新收退款资金
→ _sendTokens(...payer)：转给原付款人
```

标准 OperatorRefundCollector 的关键动作是从 `paymentInfo.operator` 执行 transferFrom，收款地址为 TokenStore。operator 需要新资金，且 allowance 要给这个退款 Collector；不是给 TokenStore 或 Escrow。

因此，原来商家收到的 5.94、费用方收到的 0.06 不会自动被追回。全退 6，operator 就要另拿出 6。退款可分多次，累计不超过已扣未退金额，且不恢复 capturableAmount。

![官方 delegated 退款资金路径](../assets/auth-capture/09-refund-funding.png)

默认 delegated 情况下，官方 SDK 示例将 refundFunding 设为 false；开放前需要商家与 facilitator 的资金安排，并准备余额和 allowance。合约存在 refund 不代表平台已经承诺垫资或用户可以强制退款。配置和调用细节见[SDK 走读](auth-capture-official-code-walkthrough.md#官方-sdk-默认如何处理-refund)。生产退款使用情况本次未核实。

## 14 TokenStore：为什么能先收钱后部署

位置：[constructor](https://github.com/base/commerce-payments/blob/b748fdd7a830a655a19a530edcf2a94b9dc7d25f/src/AuthCaptureEscrow.sol#L185)、[getTokenStore](https://github.com/base/commerce-payments/blob/b748fdd7a830a655a19a530edcf2a94b9dc7d25f/src/AuthCaptureEscrow.sol#L393)、[_sendTokens](https://github.com/base/commerce-payments/blob/b748fdd7a830a655a19a530edcf2a94b9dc7d25f/src/AuthCaptureEscrow.sol#L433)、[TokenStore.sendTokens](https://github.com/base/commerce-payments/blob/b748fdd7a830a655a19a530edcf2a94b9dc7d25f/src/TokenStore.sol#L33)。

Escrow 的 constructor 先部署一个 TokenStore 实现模板，并把自身地址作为固定授权者。各 operator 使用模板 clone，getTokenStore 根据模板、operator 派生的 salt、Escrow 部署者地址预测 CREATE2 地址。

ERC-20 余额由 token 合约按地址记录，接收地址当时不必有代码。因此 Collector 可以先把钱转到预测地址。第一次需要支出时，_sendTokens 尝试调用 sendTokens；如果该地址尚无代码，就部署确定地址 clone，再重新执行转账。

TokenStore 的业务入口很小：先确认 msg.sender==authCaptureEscrow，再 SafeERC20.safeTransfer。它不保存订单编号和订单余额，也没有自己的收费策略。

同一链、同一 Escrow、同一 operator 共用一个资金容器，订单账本仍各自独立。facilitator 换提交地址就换 TokenStore；不能拿新地址去操作旧订单。

## 15 ERC6492SignatureHandler：准备钱包，不替 token 验签

位置：[_handleERC6492Signature](https://github.com/base/commerce-payments/blob/b748fdd7a830a655a19a530edcf2a94b9dc7d25f/src/collectors/ERC6492SignatureHandler.sol#L33)。

两个付款 Collector 共用这个辅助类。它检查签名尾部 magic value：不是 ERC-6492 就原样返回；是则解出 prepareTarget、prepareData 和内部签名，通过中立 Multicall3 发起准备调用，再返回内部签名给 token / Permit2 授权流程。

这里没有“钱包准备调用成功就付款”的逻辑，也不自行完成最终验签。准备调用通过 requireSuccess=false 的 tryAggregate 发出，最终能否收款仍取决于后面的授权与真实代币转移。SDK 对未部署钱包的准入、模拟规则另见[完整代码走读](auth-capture-official-code-walkthrough.md)。

## 16 用一笔订单核对所有状态变化

下面金额均为 USDC，假设每步都成功且满足相应期限：

| 操作 | hasCollected | capturable | refundable | 实际资金变化 |
| --- | --- | --- | --- | --- |
| 初始 | false | 0 | 0 | 未收款 |
| authorize(10) | true | 10 | 0 | 用户付 10，进入 TokenStore |
| capture(6)，费用 0.06 | true | 4 | 6 | 费用方收 0.06，商家收 5.94 |
| void() | true | 0 | 6 | 剩余 4 回用户 |
| refund(2) | true | 0 | 4 | operator 新出 2 给用户 |
| refund(4) | true | 0 | 0 | operator 再出 4 给用户 |

最后两个余额都是零，hasCollected 仍为 true，这个支付身份不能再充值、authorize 或 charge。另一笔独立订单若走 charge(6)，则直接从初始状态变为 true、0、6。

## 17 读完后去看哪些测试

| 官方测试源码 | 对应阅读点 |
| --- | --- |
| [authorize.t.sol](https://github.com/base/commerce-payments/blob/b748fdd7a830a655a19a530edcf2a94b9dc7d25f/test/src/PaymentEscrow/authorize.t.sol) | 首次收款、金额与期限、重复收款 |
| [capture.t.sol](https://github.com/base/commerce-payments/blob/b748fdd7a830a655a19a530edcf2a94b9dc7d25f/test/src/PaymentEscrow/capture.t.sol) | operator 权限、部分与分次扣款、费用 |
| [charge.t.sol](https://github.com/base/commerce-payments/blob/b748fdd7a830a655a19a530edcf2a94b9dc7d25f/test/src/PaymentEscrow/charge.t.sol) | 一次收款分账、单次使用 |
| [void.t.sol](https://github.com/base/commerce-payments/blob/b748fdd7a830a655a19a530edcf2a94b9dc7d25f/test/src/PaymentEscrow/void.t.sol) | 退回剩余托管款 |
| [reclaim.t.sol](https://github.com/base/commerce-payments/blob/b748fdd7a830a655a19a530edcf2a94b9dc7d25f/test/src/PaymentEscrow/reclaim.t.sol) | 付款人到期取回 |
| [refund.t.sol](https://github.com/base/commerce-payments/blob/b748fdd7a830a655a19a530edcf2a94b9dc7d25f/test/src/PaymentEscrow/refund.t.sol) | 退款出资、额度与期限 |

本文检查实现及相关测试源码，没有运行上述测试。TokenStore 转账、Collector 验签收款和 SDK 代办规则共同构成完整路径；基础 Escrow 不判断交付，不保证 facilitator 持续在线，也不预存退款准备金。
