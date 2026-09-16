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
- 开售时间由 `reconcileStart(plannedMs, chainStartMs, nowMs, round)` 统一裁决：晚于计划→重锚再等；早于计划→立刻对齐到新时间；`plannedMs=null`（批量到达时已过配置开售）但链上开售仍在未来→改为等待；上限用尽则采用新时间直接发送
- 长等待结束后、拉 nonce 前再 `warmConnections` 一次：keep-alive 套接字通常已被对端关闭，广播不应重付握手
- 链上公售不可读（`buildLocalMintPlan` 返回 null）→ 该目标 SKIPPED
- 供应量检查（T-refresh 内、签名前）：读 NFT 合约 `getMintStats`（非 SeaDrop 单例，单例会 revert）；全局剩余 ≤ 0 → 该目标 SKIPPED（白名单常把公售库存提前清空）；剩余 < 请求总量 → 警告；单钱包 `已铸 + quantity > maxTotalMintableByWallet` → 该钱包从本次发送中剔除（保留原 idx，结果记 SKIPPED），全部被剔除则整目标 SKIPPED；合约不响应时返回 null，不阻塞
- 未传 `refreshBeforeMs` / `maxValueWei` 时（向导路径）行为与历史版本一致，签名仍在 T-refresh 前完成
- RPC 直连 sequencer 端点（只收不读）也参与广播
- 未收到任何 RPC 接受时不等待回执

## API接口
### 导出
- `fetchPublicDrop(rpcUrl, nftContract)` → PublicDrop | null（非 SeaDrop/新版变体返回 null）
- `fetchMintStats(rpcUrlOrProvider, nftContract, minter)` → MintStats | null（NFT 合约的 `getMintStats`，非 ERC721SeaDrop 返回 null）
- `resolveFeeRecipient(...)`、`encodeMintPublic(...)`、`buildLocalMintPlan(...)` → LocalMintPlan
- `localPublicSnipe(opts)` → `Promise<SnipeResult[]>`：预热 →（可选）T-refresh 重读/重锚/护栏/供应量检查 → 二次预热 → 拉 pending nonce → 签名 → 定时 → 广播 → 回执
- `reconcileStart(plannedMs, chainStartMs, nowMs, round)` → `{ startMs, rewait }`：开售时间漂移裁决（纯函数）
- `supplyVerdict(totalMinted, maxSupply, requested)` → `"sold-out" | "tight" | "ok"`（纯函数）
- `exceedsWalletCap(minted, quantity, cap)` → boolean（纯函数，cap=0 视为不限）
- `SnipeStatus` = `SUCCESS | REVERTED | TIMEOUT | REJECTED | SKIPPED`

## 数据模型
- LocalMintPlan: `{ to, data, value, drop, feeRecipient }`
- MintStats: `{ mintedByWallet, totalMinted, maxSupply }`（均为 bigint；totalMinted 累计含已销毁）
- LocalSnipeOpts: 原字段 + 可选 `maxValueWei`（总价上限）、`refreshBeforeMs`（T-refresh 提前量）
- SnipeResult: `{ idx, address, txHash, status }`
- 常量: SEADROP_ADDRESS、OPENSEA_FEE_RECIPIENT、MAX_START_MOVES

## 依赖
- rpc-blast / connection-warmer / timer / chains / time-format / seadrop-public / ethers

## 变更历史
- [202609141442_zh-cn-i18n](../../history/2026-09/202609141442_zh-cn-i18n/) - 越南语文案翻译为简体中文
- [202609141521_cli-en](../../history/2026-09/202609141521_cli-en/) - CLI 文案英文化 + 时区切换为 UTC+8
- [202609151934_batch-timed-mint](../../history/2026-09/202609151934_batch-timed-mint/) - T-refresh 重读/重锚与价格护栏，返回 SnipeResult
- [202609152008_review-fixes](../../history/2026-09/202609152008_review-fixes/) - T-refresh 后二次预热 + startTime 漂移裁决边界（含 planned=null 与提前开售）
- [202609161339_supply-check](../../history/2026-09/202609161339_supply-check/) - getMintStats 售罄/单钱包上限检查，售罄目标不再白付 gas
