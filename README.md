# 未评审研究文档

boboliu-1010 的研究与分享草稿，尚未经评审。每份调研都附运行命令和实际结果，没验证的部分直接写明。

## x402 auth-capture 分享

用“上限 10 USDC、实际消费 6、费用 1%”这个例子，介绍 auth-capture 的支付机制、合约实现和接入方式。

| 文档 | 内容 |
| --- | --- |
| **[分享主稿](docs/auth-capture-contract-analysis.md)** | 项目背景、支付路径、合约分工、分账退款和应用案例 |
| **[Solidity 合约源码走读](docs/auth-capture-solidity-walkthrough.md)** | 合约来源、PaymentInfo、账本、六种操作、Collector、TokenStore 与逐层调用 |
| **[SDK、接口与 TRON 接入](docs/auth-capture-official-code-walkthrough.md)** | 服务端配置、钱包签名、facilitator、重试和 TRON 移植 |

先看[主稿开头的完整流程图](docs/auth-capture-contract-analysis.md#先看完整流程)，把请求、收款、分账和退款串起来；需要细节再看合约或 SDK。配图和可编辑图源在 [assets/auth-capture](assets/auth-capture/README.md)。

已核验 Base Sepolia 部署，完成 20 笔公开链交易、112 项合约测试和 472 项 SDK 单测。固定版本的 sync 后置回调漏更新账本，后续 SDK 退款被拒；该笔退款已由 operator 直接调用合约完成，演示保留原版 SDK，只对该笔退款做了恢复处理。结果、配图和命令见[验证与演示](docs/auth-capture-contract-analysis.md#9-实际验证和演示)。源码版本和其余测试状态见[主稿末尾](docs/auth-capture-contract-analysis.md#10-源码版本)。
