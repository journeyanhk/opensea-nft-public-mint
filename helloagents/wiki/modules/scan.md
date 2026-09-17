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
- 发现主题：`PublicDropUpdated`（配置出现/变更）与 `SeaDropMint`（铸造活动），一次 `eth_getLogs`（topic0 OR）取回，`topic1` 即合约地址
- 发现窗口独立于审计窗口（`discoveryWindowBlocks`：Robinhood 10k、Arc 5k）：无 topic1 过滤的 OR 查询在 100k 块窗口下会超过公共 RPC 的 1 万条日志上限；仍超限时 `scanLogs` 自适应二分（命中 `exceeds limit` 类错误即对半拆，下限 64 块）
- 游标只前进到 `latest − 64`（确认延迟），增量扫描每次仅数个窗口；首次无游标按 `--since-days`（默认 1 天）回看
- 候选过滤用 `buildLocalMintPlan`（等价于脚本能否构造交易），再查 `getMintStats` 排除已售罄；公售已结束或开售超出 `--horizon-hours`（默认 72h）的合约记数跳过
- 重审策略：新合约必审；已知合约在"有新事件（`lastSeenBlock > lastAuditedBlock`）"或"开售临近 horizon 且距上次审计超 30 分钟"时重审；售罄合约仅在出现新事件后重查
- `--limit` 之外的候选写入 `pendingAudit`，下次运行**优先消化积压**再处理新发现；审计成功或判定售罄/过期/暂不需审时清除，审计失败保留待重试
- 公共 RPC 限流严重：Arc 与 Robinhood 均串行扫描（`SCAN_CONCURRENCY`），限流错误退避上限 15s、发现阶段重试 8 次；配置私有 RPC 才是提速手段
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
- 建议由 cron/定时任务每 10–30 分钟运行一次（增量成本极低）

## 数据模型
- `ChainCursor`: `{ cursorBlock, blockTimeSec, updatedAt }`
- `ContractEntry`: `{ firstSeenBlock, lastSeenBlock, lastAuditedBlock, lastAuditedAt, lastGrade, soldOutAtBlock, publicStart, pendingAudit }`
- `ChainScanReport`: `{ chainKey, fromBlock, toBlock, windows, discovered, newContracts, candidates, skipped: { ended, far, soldOut, notApplicable, known, limited }, audited }`

## 依赖
- audit/events（窗口扫描与重试）、audit/audit（体检）、audit/score（余量计算）、audit/report（渲染与导出）、chains、rpc-resolver、seadrop-public

## 变更历史
- [202609171557_scan-discovery](../../history/2026-09/202609171557_scan-discovery/) - 新增 `--scan` 发现器（游标 + 单例事件扫描 + 候选过滤 + 状态快照）
