# 未评审研究文档

本仓库公开收录 boboliu-1010 尚未评审的研究和分享草稿。评审完成后，记录范围、日期和结论，再决定如何归档。

## x402 auth-capture 分享

整套材料收敛为三篇，以“上限 10 USDC、实际消费 6、费用 1%”贯穿说明。

| 文档 | 内容 |
| --- | --- |
| **[分享主稿](docs/auth-capture-contract-analysis.md)** | 分享入口：项目背景、支付路径、合约分工、分账退款、应用证据与来源 |
| **[Solidity 合约源码走读](docs/auth-capture-solidity-walkthrough.md)** | 合约来源、PaymentInfo、账本、六种操作、Collector、TokenStore 与逐层调用 |
| **[SDK、接口与 TRON 接入](docs/auth-capture-official-code-walkthrough.md)** | 服务端配置、钱包签名、facilitator、重试，以及 TRON 移植与验证范围 |

先读主稿，需要细节再看后两篇。基础概念已并入主稿和合约走读，TRON 适配并入 SDK；不再单独维护两篇文档。配图及可编辑图源见 [assets/auth-capture](assets/auth-capture/README.md)。

所有材料均未经评审。已做静态源码阅读和文档检查，尚未运行 SDK / Foundry 测试、独立核实生产链上用量或验证 TRON 部署。详见[源码版本与验证范围](docs/auth-capture-contract-analysis.md#9-源码版本与验证范围)。
