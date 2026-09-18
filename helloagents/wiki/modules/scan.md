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
- 重审策略：新合约必审；已知合约在"有新事件"、"开售 72 小时内（含已开售，`REAUDIT_OPENED_HOURS`）且距上次审计超 30 分钟"、"开售临近 horizon 且距上次审计超 30 分钟"时重审；售罄合约仅在出现新事件后重查；候选排序 = 积压 > 最久未审的已开售 > 新发现/临近
- `--limit` 之外的候选写入 `pendingAudit`，下次运行**优先消化积压**再处理新发现；审计成功或判定售罄/过期/暂不需审时清除，审计失败保留待重试
- 公共 RPC 限流严重：Arc 与 Robinhood 均串行扫描（`SCAN_CONCURRENCY`），限流错误退避上限 15s、发现阶段重试 8 次；`SCAN_RPC_URL_<CHAIN>`（宽范围付费节点）才是提速手段
- 历史记录写入审计事实：名称/owner/价格/每钱包上限/结束时间/供应与已铸/15m 与 1h 铸造量/独立地址/集中度/阶段数（见 data.md）——面板据此展示需求信号
- 发现结果先落盘再审计；审计失败只记录，下次扫描会自动重试（`eventSinceAudit` 仍为真）

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
