# local-mint 模块

## 目的
公售路径：本地从链上构造 SeaDrop mint calldata，提前签名，开售瞬间向多 RPC 并发广播。

## 模块概述
- **职责:** fetchPublicDrop/resolveFeeRecipient/encodeMintPublic 构造 calldata；预签名；warmConnections 预热；blastToAll 并发广播；waitForReceipt 回执轮询
- **状态:** ✅稳定
- **最后更新:** 2026-09-14

## 规范
### 需求: 公售抢 mint
**模块:** local-mint
- minterIfNotPayer=0 → calldata 所有钱包字节相同，只需编码/签名一次
- T-0 前完成全部计算工作，到点只写字节到 socket
- RPC 直连 sequencer 端点（只收不读）也参与广播
- 未收到任何 RPC 接受时不等待回执

## API接口
### 导出
- `fetchPublicDrop(rpcUrl, nftContract)` → PublicDrop | null（非 SeaDrop/新版变体返回 null）
- `resolveFeeRecipient(...)`、`encodeMintPublic(...)`、`buildLocalMintPlan(...)` → LocalMintPlan
- `localPublicSnipe(opts)`：预签名 + 定时 + 广播 + 回执

## 数据模型
- LocalMintPlan: `{ to, data, value, drop, feeRecipient }`
- 常量: SEADROP_ADDRESS、OPENSEA_FEE_RECIPIENT

## 依赖
- rpc-blast / connection-warmer / timer / chains / seadrop-public / ethers

## 变更历史
- [202609141442_zh-cn-i18n](../../history/2026-09/202609141442_zh-cn-i18n/) - 越南语文案翻译为简体中文
- [202609141521_cli-en](../../history/2026-09/202609141521_cli-en/) - CLI 文案英文化 + 时区切换为 UTC+8
