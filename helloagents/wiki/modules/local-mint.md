# local-mint 模块

## 目的
公售路径：本地从链上构造 SeaDrop mint calldata，在开售前重读参数并签名，开售瞬间向多 RPC 并发广播。

## 模块概述
- **职责:** fetchPublicDrop/resolveFeeRecipient/encodeMintPublic 构造 calldata；T-refresh 重读、startTime 重锚与价格护栏；预签名；warmConnections 预热；blastToAll 并发广播；waitForReceipt 回执轮询；返回 SnipeResult
- **状态:** ✅稳定
- **最后更新:** 2026-09-15

## 规范
### 需求: 公售抢 mint
**模块:** local-mint
- minterIfNotPayer=0 → calldata 所有钱包字节相同，只需编码/签名一次
- T-0 前完成全部计算工作，到点只写字节到 socket
- 传入 `refreshBeforeMs` 时签名推迟到开售前该毫秒数：重读 getPublicDrop 与费用接收人；链上 `startTime` 比计划晚则重锚等待（最多 `MAX_START_MOVES=2` 次）；`fresh.value > maxValueWei` 则该目标全部钱包 SKIPPED
- 链上公售不可读（`buildLocalMintPlan` 返回 null）→ 该目标 SKIPPED
- 未传 `refreshBeforeMs` / `maxValueWei` 时（向导路径）行为与历史版本一致，签名仍在 T-refresh 前完成
- RPC 直连 sequencer 端点（只收不读）也参与广播
- 未收到任何 RPC 接受时不等待回执

## API接口
### 导出
- `fetchPublicDrop(rpcUrl, nftContract)` → PublicDrop | null（非 SeaDrop/新版变体返回 null）
- `resolveFeeRecipient(...)`、`encodeMintPublic(...)`、`buildLocalMintPlan(...)` → LocalMintPlan
- `localPublicSnipe(opts)` → `Promise<SnipeResult[]>`：预热 →（可选）T-refresh 重读/重锚/护栏 → 拉 pending nonce → 签名 → 定时 → 广播 → 回执
- `SnipeStatus` = `SUCCESS | REVERTED | TIMEOUT | REJECTED | SKIPPED`

## 数据模型
- LocalMintPlan: `{ to, data, value, drop, feeRecipient }`
- LocalSnipeOpts: 原字段 + 可选 `maxValueWei`（总价上限）、`refreshBeforeMs`（T-refresh 提前量）
- SnipeResult: `{ idx, address, txHash, status }`
- 常量: SEADROP_ADDRESS、OPENSEA_FEE_RECIPIENT、MAX_START_MOVES

## 依赖
- rpc-blast / connection-warmer / timer / chains / time-format / seadrop-public / ethers

## 变更历史
- [202609141442_zh-cn-i18n](../../history/2026-09/202609141442_zh-cn-i18n/) - 越南语文案翻译为简体中文
- [202609141521_cli-en](../../history/2026-09/202609141521_cli-en/) - CLI 文案英文化 + 时区切换为 UTC+8
- [202609151934_batch-timed-mint](../../history/2026-09/202609151934_batch-timed-mint/) - T-refresh 重读/重锚与价格护栏，返回 SnipeResult
