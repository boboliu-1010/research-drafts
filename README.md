# 未评审研究文档

本仓库公开收纳 boboliu-1010 的未评审研究、分享草稿和代码走读。目录中的材料均标记为未经评审，不能仅凭收录或提交记录视为正式方案、审计结论或已验证实现。

## auth-capture

- [支付机制与合约分享](docs/auth-capture-contract-analysis.md)：对比 exact、先托管后 capture、直接 charge，讲清合约、退款资金、故障处理和 TRON 移植；正文配 5 张图。
- [Solidity 合约源码走读](docs/auth-capture-solidity-walkthrough.md)：按函数阅读 Escrow、TokenStore 和 Collector，解释检查顺序、msg.sender、签名绑定和状态变化。
- [官方代码走读](docs/auth-capture-official-code-walkthrough.md)：固定官方源码提交，包含函数、行号、资金与权限边界。
- [配图与可编辑图源](assets/auth-capture/)：Mermaid 和 SVG。

## 文档状态

新增且尚未评审的研究材料统一放入本公开仓库，并在文档开头标注“未经评审”。完成评审后，记录评审范围、日期和结论，再决定后续归档位置。公开收录不代表文档已经评审通过。

本次迁入仅包含上述 auth-capture 文档及其图源，不包含其他仓库的代码、配置或历史记录。
