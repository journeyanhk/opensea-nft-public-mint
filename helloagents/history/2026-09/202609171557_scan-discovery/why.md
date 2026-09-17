# 变更提案: 发现器 `--scan`（M2）

## 需求背景

M1 解决了"已知目标值不值得排"，但目标仍需人工提供。M2 补上发现：自动看到链上**新出现/近期有铸造活动**的 SeaDrop drop，过滤出未来一段时间内开售、且公售确实有货的候选，直接进 M1 审计并导出。

关键实测支撑（2026-09-17）：

- SeaDrop 单例同时发出配置事件与全部铸造事件（`SeaDropMint` 带 `dropStageIndex`），一个地址即可覆盖全部 drop，无需逐个 token 扫描
- Robinhood 出块 0.101s、`eth_getLogs` 支持 100k 块/窗口；Arc 出块 0.51s、窗口上限实测 5,000 块（10,000 报 `requested range too large`）
- Robinhood 4.6 天有 3,049 条 `PublicDropUpdated`，Arc 42 分钟有 3,499 条 `SeaDropMint` → 发现量充足，需要过滤而不是"找不到"

用户已确认的 M2 规格：每链 JSON 游标、分窗口 + 重试退避 + 确认延迟、新合约自动进 M1 审计、`--grade` 过滤、`.scan-state.json` + JSONL 快照、不引入原生依赖。

## 变更内容

1. 新增 `src/scan/state.ts`：`.scan-state.json`（每链游标 + 每合约发现/审计状态）与 `.scan-history.jsonl`（每次审计的快照行），原子写入。
2. 新增 `src/scan/scanner.ts`：`runScan()` —— 按主题 OR 扫描 `PublicDropUpdated` + `SeaDropMint`，取 `topic1`（nftContract）去重；候选过滤（公售未结束、开售在 horizon 内、未售罄）；已知合约仅在"有新事件"或"临近开售需刷新"时重审；产出 `ScanReport[]`。
3. 新增 `src/scan/cli.ts` 与 `npm start -- --scan` 入口：多链、`--since-days`、`--horizon-hours`、`--limit`、`--grade`、`--export`（复用 M1 导出与校验）、`--json`、`--no-audit`。
4. 知识库、README、`.gitignore`、CHANGELOG 同步。

## 影响范围

- **新增:** `src/scan/{state,scanner,cli}.ts`、`tests/scan.cjs`
- **修改:** `src/index.ts`（`--scan` 分支与 HELP）、`.gitignore`（`.scan-state.json`、`.scan-history.jsonl`）、`README.md`、`helloagents/wiki/*`
- **复用:** `audit/events`（窗口扫描/重试）、`audit/audit`（审计）、`audit/report`（表格与导出）
- **不做:** M3 看板与地板价回填；不引入 SQLite 等原生依赖

## 核心场景

### 需求: 发现新目标
**模块:** scan

#### 场景: 增量扫描（有游标）
上次停在 `cursorBlock`，本次扫 `cursor+1 → latest-64`。
- 只拉取新区块的事件，窗口数极少（Robinhood 10 分钟 ≈ 6k 块、Arc ≈ 1.2k 块）
- 新出现的合约写入状态并进入候选过滤
- 扫描结束后游标前进到 `latest-64`（64 块确认延迟，Arc 约 33s、Robinhood 约 6s）

#### 场景: 首次扫描（无游标）
`--since-days`（默认 1 天）回看，按链上平均出块时间换算成区块数。
- 首次可能较慢（Robinhood 约 9 窗口、Arc 约 34 窗口），之后恢复增量

#### 场景: 候选过滤与审计
对发现的合约逐个做最小链上读取（`getPublicDrop` + `getMintStats(0x0)`）。
- 公售已结束 / 开售在 horizon（默认 72h）之外 / 已售罄 → 记为跳过，不消耗审计
- 通过者按 `--limit`（默认 20）进入 M1 审计；已知合约只在"有新事件"或"临近开售"时重审
- 审计结果按 `--grade` 过滤后复用 M1 表格与 `--export`

### 需求: 状态与快照
**模块:** scan
- `.scan-state.json` 记录每链游标与每合约 `{ firstSeenBlock, lastSeenBlock, lastAuditedBlock, lastAuditedAt, lastGrade, soldOutAtBlock }`
- `.scan-history.jsonl` 每行一条审计快照（时间、链、合约、等级、上界/预计余量），供后续回看与（M3）校准

## 风险评估

- **风险:** 首次扫描窗口多、Arc 公共 RPC 限流导致耗时。**缓解:** 串行/低并发 + 指数退避；`--since-days` 可调；增量后每次仅数个窗口。
- **风险:** 发现量过大（每天数百）导致候选检查与审计过多。**缓解:** `--limit` 限制单次审计数；horizon 过滤；售罄合约记录后不再重查（除非有新事件）。
- **风险:** 确认延迟不足导致 reorg 后游标越过事件。**缓解:** 64 块确认延迟 + 每合约以 `lastSeenBlock` 记录，重扫时可用 `--since-days` 回补。
- **风险:** 状态文件损坏。**缓解:** 原子写入（临时文件 + rename）；解析失败按空状态处理并告警。
- **风险:** 状态文件泄漏隐私。**缓解:** 只含链上与时间信息，无密钥；加入 `.gitignore`。
