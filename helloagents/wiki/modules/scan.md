# scan 模块

## 目的
发现器：监听 SeaDrop 单例事件，自动找出新出现或有铸造活动的 drop，过滤出未来 horizon 内开售且公售有货的候选，交给 audit 模块体检。

## 模块概述
- **职责:** 每链 JSON 游标；单例 `PublicDropUpdated` OR `SeaDropMint` 分窗口扫描（确认延迟 64 块）；按 `topic1` 去重合约；候选过滤（`buildLocalMintPlan` + `getMintStats`）；重审策略；`.scan-state.json` 原子写 + `.scan-history.jsonl` 追加；`--scan` CLI
- **状态:** ✅稳定
- **最后更新:** 2026-09-17

## 规范
### 需求: 发现新目标
**模块:** scan
- 发现主题默认只订阅 `PublicDropUpdated`（能被脚本 mint 的 drop 必然发过配置事件），`topic1` 即合约地址；`--include-mints` 可额外订阅 `SeaDropMint`（日志量高一个数量级，窗口降到 10k）
- 发现窗口（`discoveryWindowBlocks`）：仅配置事件时用链默认窗口（Robinhood 100k、Arc 5k）；带 `--include-mints` 时降到 10k。被节点以范围/结果过多拒绝时，`scanLogs` 采用节点提示的范围（如 Arc 的 `retry with the range A-B`）或二分（下限 64 块）
- 端点角色：扫描使用 `resolveScanRpcs`（公共优先，`SCAN_RPC_URL_<CHAIN>` 可固定）；被 10 块级范围上限拒绝的端点会被跳过，换下一个候选
- 范围类错误是确定性的：不再退避重试，直接拆分或换端点；限流类错误才走长退避
- 游标只前进到 `latest − 64`（确认延迟），增量扫描每次仅数个窗口；首次无游标按 `--since-days`（默认 1 天）回看
- 候选过滤用 `buildLocalMintPlan`（等价于脚本能否构造交易），再查 `getMintStats` 排除已售罄；公售已结束或开售超出 `--horizon-hours`（默认 72h）的合约记数跳过
- 重审策略：新合约必审；已知合约在"有新事件"、"开售 72 小时内（含已开售，`REAUDIT_OPENED_HOURS`）且距上次审计超 30 分钟"、"开售临近 horizon 且距上次审计超 30 分钟"时重审；售罄合约仅在出现新事件后重查；候选排序 = 新工作（积压 + 新发现/临近）优先，复审按最久未审填充余量；连续两次无新增铸造的目标复审间隔放宽到 2 小时
- `--limit` 之外的候选写入 `pendingAudit`，下次运行**优先消化积压**再处理新发现；审计成功或判定售罄/过期/暂不需审时清除，审计失败保留待重试
- 公共 RPC 限流严重：Arc 与 Robinhood 均串行扫描（`SCAN_CONCURRENCY`），限流错误退避上限 15s、发现阶段重试 8 次；`SCAN_RPC_URL_<CHAIN>`（宽范围付费节点）才是提速手段
- 历史记录写入审计事实：名称/owner/价格/每钱包上限/结束时间/供应与已铸/15m 与 1h 铸造量/独立地址/集中度/阶段数（见 data.md）——面板据此展示需求信号
- 发现结果先落盘再审计；审计失败只记录，下次扫描会自动重试（`eventSinceAudit` 仍为真）

### 需求: 状态补齐（--refresh-targets）
**模块:** scan
- 对 `.scan-state.json` 中缺 slug/name/endTime/totalMinted/**owner**/**社交**的合约做轻量刷新：`buildLocalMintPlan` + `getMintStats` +（有 key 时）OpenSea 反查 slug + `name()` + `owner()` +（无 key 也可）`collections/<slug>`
- 幂等、可重复执行；`--limit` 控制单次数量，结束时报告 `remaining`；典型数百合约一两分钟跑完
- 面板 phase 判定即依赖这些字段：`upcoming`（未开售）、`live-fresh`（开售 ≤24h）、`live`、`stale`、`sold-out`、`ended`、`unaudited`
- M5b：collections 读取缩略图/社交/创建日期/safelist，404 视为「已知为空」写入 `socialCheckedAt`（不重复请求），限流/网络失败不写、下次重试；`ENABLE_X_METRICS=1` 时额外抓 X 粉丝数（`api.fxtwitter.com`，24h 缓存，失败静默）
- 限速与 429：所有 OpenSea 调用共用一个 `RateLimiter`（`OPENSEA_RPS`，默认 2 req/s）；`limitedFetch` 对 429 读 `retry-after` 退避重试一次，仍失败计入 `RefreshSummary.rateLimited`；所有请求带 15s 超时（X 为 10s）
- 并发写安全：刷新只写本次刷新的字段，`saveStateMerged` 先读回文件再按合约字段合并，不会覆盖并发扫描的发现或游标
- `--serve` 的调度器每轮扫描后跑一次有界刷新（`REFRESH_PER_TICK`，默认 20，0 = 关闭），迁移无需停服；`/api/status` 暴露 `refresh` 摘要
- 创作者历史与 Q 分是派生数据（不落盘）：`src/scan/quality.ts` 的 `creatorStatsFor(owner, facts, …, exclude)`（按 owner 且排除目标自身）与 `qualityScore`（0–100 + `confidence`；惩罚项含 `instant-sellout`）

### 需求: OpenSea 日历第二信息源（M7/A1）
**模块:** scan
- `src/scan/calendar.ts`：`parseCalendar`（只读页面中含 `urql_transport` 的 script push JSON，找 `dropCalendar.items`；**解析不到即 throw**）、`fetchCalendar`（固定浏览器 UA、跟随 307、15s 超时）、`calendarVerdict`（金丝雀：某链由有变 0 / 总量骤降 >80%）、`upsertCalendar`（只补日历字段，slug 已存在不覆盖）
- `refreshCalendar`（scanner）：每 `CALENDAR_INTERVAL_MIN`（默认 15）抓一次；失败记 `calendar unavailable` 并沿用旧快照（绝不静默清空）；成功更新 `state.calendar.counts` 作为下次金丝雀基线
- 面板：`日历/未认证/平台禁用` 徽标 + 明细（收录时间/开售/地板/最高报价/供应/阶段数）；`classifyPhase` 对「未来开售但尚无链上事实」的条目判 `upcoming` 而不是 `unaudited`

### 需求: 状态与快照
**模块:** scan
- `.scan-state.json`（`version: 1`）：`chains[chain] = { cursorBlock, blockTimeSec, updatedAt }`；`contracts[chain][contract] = { firstSeenBlock, lastSeenBlock, lastAuditedBlock, lastAuditedAt, lastGrade, soldOutAtBlock, publicStart, pendingAudit }`
- 写入为临时文件 + rename 原子操作；文件缺失视为空状态，损坏则告警并按空状态继续
- `.scan-history.jsonl` 每行一条审计快照：`{ at, chain, contract, grade, remaining, projected, start }`

## API接口
### 导出（`src/scan/`）
- `runScan(opts, onProgress)` → `Promise<ChainScanReport[]>`：完整发现+过滤+审计流程
- `parseScanArgs(args)` / `runScanCommand(args)`（cli）
- 状态：`loadState` / `saveState` / `recordContracts` / `advanceCursor` / `appendHistory`
- 纯函数：`discoveryTopics()`、`isCandidateDrop(drop, nowSec, horizonHours)`、`shouldAudit({ entry, eventSinceAudit, startAtMs, nowMs, horizonMs, reauditMs })`

### CLI
- `npm start -- --scan [--chain robinhood,arc] [--since-days 1] [--horizon-hours 72] [--limit 20] [--lookback-days 0.5] [--grade A,B] [--export <path>] [--force] [--quantity N] [--max-price <eth|current>] [--json] [--no-audit]`
- `npm start -- --report <out.html> [--state <file>] [--history <file>] [--ledger <file>]`（可单独使用，也可与 `--scan` 连用：先扫描再生成）
- 建议由 cron/定时任务每 10–30 分钟运行一次（增量成本极低）

## 看板（--report）
- 输入三个本地文件：`.scan-state.json`（合约状态）、`.scan-history.jsonl`（等级/余量轨迹）、`.batch-state.json`（执行结果）；可选读取 `.audit-cache/` 得到分阶段铸造与变更标注
- 输出单文件 HTML：无 server、无外部资源；全字段转义；等级/链筛选、列排序、搜索、勾选生成短名单与命令；交易链接指向对应链浏览器
- 纯函数：`parseHistory` / `loadDashboardRows` / `renderDashboard` / `escapeHtml`

## 数据模型
- `ChainCursor`: `{ cursorBlock, blockTimeSec, updatedAt }`
- `ContractEntry`: `{ firstSeenBlock, lastSeenBlock, lastAuditedBlock, lastAuditedAt, lastGrade, soldOutAtBlock, publicStart, pendingAudit }`
- `ChainScanReport`: `{ chainKey, fromBlock, toBlock, windows, discovered, newContracts, candidates, skipped: { ended, far, soldOut, notApplicable, known, limited }, audited }`

## 依赖
- audit/events（窗口扫描与重试）、audit/audit（体检）、audit/score（余量计算）、audit/report（渲染与导出）、chains、rpc-resolver、seadrop-public

## 变更历史
- [202609171557_scan-discovery](../../history/2026-09/202609171557_scan-discovery/) - 新增 `--scan` 发现器（游标 + 单例事件扫描 + 候选过滤 + 状态快照）
