# audit 模块

## 目的
目标体检：在把目标排进批量之前，用链上数据判断"公售还有没有货"与"项目方有没有临时改参数"，并导出可被批量模式直接使用的配置。

## 模块概述
- **职责:** SeaDrop 事件扫描（单例 `SeaDropMint`/`PublicDropUpdated`，分窗口+重试+缓存）；链上读取（公售参数、累计铸造、逐钱包已铸、signers、费用接收人）；两套余量（上界/实测投影）与风险标签打分；表格渲染与 `targets.<chain>.json` 导出（复用 `loadBatchConfig` 校验）；`--audit` CLI
- **状态:** 🚧开发中（M1）；M2 发现器（`--scan`）与 M3 看板未实现
- **最后更新:** 2026-09-17

## 规范
### 需求: 目标审计
**模块:** audit
- 判据以链上为准：`getMintStats.totalMinted`（累计含销毁）与 `SeaDropMint` 事件；OpenSea API 只做增强，无 key 不影响等级
- 两个余量各自给 A/B/C，综合取较差者；`rateConfident`（样本 ≥10 分钟且 ≥20 枚）不足时不因投影判 C
- 公售已开始时，"剩余 ≤ 0"是观测事实而非投影，不受 `rateConfident` 影响
- D 级仅在 API 可用时给出（无任何社交 且 创建距开售 < 24 小时）；开售前 60 分钟内改价/改期只标 ⚠，不单独降级
- 事件扫描按链窗口上限分片（Robinhood 100k、Arc 5k；发现阶段另用 10k），默认并发见 `scanConcurrency`（Arc/Robinhood 串行），指数退避（限流类错误上限 15s）；超限窗口自适应二分；扫描结果缓存 `.audit-cache/<chain>/<contract>.json`（TTL 5 分钟，bigint 以字符串存储）
- 局部扫描保护：风险集中度只在覆盖率（`scanTokens/totalMinted`）≥50% 且样本 ≥50 枚时标注，否则标 `partial scan (x% of mints)`；报告的分阶段行会追加 `(partial scan: x/y)`

### 需求: 批量前置审计（M1.5）
**模块:** batch / batch-runner
- `targets.json` 的 `auditBeforeMs`（默认 1800000）与 `auditSkipGrades`（默认 `["C"]`）
- 到 `start − auditBeforeMs` 时审计该目标；命中跳过等级则记 `SKIPPED` 并继续
- 审计失败（RPC/API 异常）只告警并继续，T-3s 的 `getMintStats` 检查仍是最后一道兜底
- 公售已开始（`targetStart` 为空）时不重复审计

## API接口
### 导出（`src/audit/`）
- `auditTarget({ chainKey, target }, opts)` → `Promise<AuditResult>`：完整审计（链上 + 事件 + 可选 API + 打分）
- `scanLogs` / `aggregateMints` / `decodeDropUpdates` / `summarizeChanges` / `splitWindows` / `decodeMintLog`（events）
- `remainingSupply` / `gradeRemaining` / `projectedHeadroom` / `gradeProjected` / `isRateConfident` / `assessRisk` / `gradeTarget`（score，纯函数）
- `renderAuditTable` / `renderAuditDetail` / `renderJson` / `exportTargets`（report）
- `runAuditCommand(args)`（cli）

### CLI
- `npm start -- --audit <link|slug|地址|@file>... [--chain <key>] [--wallets 0x..,0x..] [--lookback-days 7] [--quantity N] [--max-price <eth|current>] [--grade A,B] [--export <path>] [--json]`

## 数据模型
- `AuditResult`: 链/合约/名称、公售参数、`totalMinted`/`maxSupply`、逐钱包已铸、`mintScan`（分阶段聚合）、`updates`+`changes`、`grade`（含 upper/projected 与 risks）、`social`/`apiStages`（可选）、`errors`
- `StageMint`: `{ stage, txs, tokens, uniqueMinters, topMinterTokens, firstBlock, lastBlock, price }`
- 缓存: `{ scannedToBlock, scannedAt, data: { mintScan, updates } }`（`.audit-cache/`，已 gitignore）

## 依赖
- chains / rpc-resolver / nft-link / slug-resolver / seadrop-public / time-format / ethers；batch-config 反向依赖 score 的 `Grade` 类型

## 变更历史
- [202609171426_target-audit](../../history/2026-09/202609171426_target-audit/) - 新增 `--audit` 审计器与批量前置审计（M1 + M1.5）
