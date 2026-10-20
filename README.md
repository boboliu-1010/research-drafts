# 未评审研究文档

boboliu-1010 的研究与分享草稿，尚未经评审。

## x402 auth-capture 分享

用“上限 10 USDC、实际消费 6、费用 1%”这个例子，介绍 auth-capture 的支付机制、合约实现和接入方式。

| 文档 | 内容 |
| --- | --- |
| **[分享主稿](docs/auth-capture-contract-analysis.md)** | 项目背景、支付路径、合约分工、分账退款和应用案例 |
| **[Solidity 合约源码走读](docs/auth-capture-solidity-walkthrough.md)** | 合约来源、PaymentInfo、账本、六种操作、Collector、TokenStore 与逐层调用 |
| **[SDK、接口与 TRON 接入](docs/auth-capture-official-code-walkthrough.md)** | 服务端配置、钱包签名、facilitator、重试和 TRON 移植 |

先读主稿，需要细节再看合约或 SDK。配图和可编辑图源在 [assets/auth-capture](assets/auth-capture/README.md)。

源码版本和测试状态见[主稿末尾](docs/auth-capture-contract-analysis.md#9-源码版本)。
