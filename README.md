# 未评审研究文档

本仓库公开收录 boboliu-1010 尚未评审的研究和分享草稿。评审完成后，记录评审范围、日期和结论，再决定如何归档。

## x402 auth-capture 分享

整套材料用“上限 10 USDC、实际消费 6、费用 1%”这个例子，解释合约如何收款、托管、分账和退款。

| 文档 | 适合什么时候看 | 内容 |
| --- | --- | --- |
| **[分享主稿](docs/auth-capture-contract-analysis.md)** | 分享时按顺序讲 | 项目背景、三条支付路径、合约分工、分账、退款、x402 与 TRON |
| [基础概念与项目关系](docs/auth-capture-foundations.md) | 第一次接触，或需要确认来源 | Commerce Payments / Coinbase Payments / x402、角色、合约分类、应用证据与源码版本 |
| **[Solidity 合约源码走读](docs/auth-capture-solidity-walkthrough.md)** | 深入读合约 | PaymentInfo、账本、六种操作、Collector 继承、TokenStore 与 msg.sender |
| [SDK 与接口走读](docs/auth-capture-official-code-walkthrough.md) | 接入服务端和钱包 | HTTP 接口、路径配置、签名、facilitator 验证、退款开关、pending 和存储 |
| [TRON 适配范围](docs/auth-capture-tron-port.md) | 评估 USDT / Permit2 移植 | 合约及 SDK 范围、CREATE2、签名兼容、执行环境与待验证事项 |
| [配图目录与可编辑图源](assets/auth-capture/README.md) | 查图、复用或修改 | 各图的适用范围、正文位置、SVG / Mermaid 源文件 |

分享时先看主稿。需要补背景时看基础概念，再依次读合约、SDK 和 TRON。原有三篇文档仍使用原来的文件路径，旧链接可以继续打开。

## 研究状态

所有材料均未经评审。已按文中列出的源码提交做静态阅读和文档检查，尚未运行 SDK / Foundry 测试、独立核实生产链上用量或验证 TRON 部署。详细范围见[源码版本与验证范围](docs/auth-capture-foundations.md#6-源码版本与验证范围)。
