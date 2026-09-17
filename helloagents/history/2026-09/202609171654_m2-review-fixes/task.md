# 任务清单: M2 review 修复（自适应二分 + 积压队列 + 局部扫描标注）

目录: `helloagents/plan/202609171654_m2-review-fixes/`

---

## 1. 阻塞项：发现窗口撞日志上限
- [√] 1.1 在 `src/audit/events.ts` 实现 `isDenseLogError()` 与 `scanLogs` 内自适应二分（命中 `exceeds limit` 类错误对半拆窗，下限 64 块），对所有扫描调用生效
- [√] 1.2 新增 `discoveryWindowBlocks()`（Robinhood 10k、Arc 5k）并在发现阶段传入 `deps.window`，避免默认参数直接撞 1 万条上限
- [√] 1.3 复现并验证：修复前 `--scan --chain robinhood --since-days 1` 抛 `logs matched by query exceeds limit of 10000`；修复后 86 窗口/614 合约完成（5 分 14 秒）

## 2. 限流与并发
- [√] 2.1 Robinhood 也改为串行扫描（`SCAN_CONCURRENCY`），发现阶段 `maxRetries` 提到 8，缓解公共 RPC 429
- [√] 2.2 Arc `--since-days 0.25` 首次回填实测 9 窗口 / 139 合约 / 52 秒

## 3. 超限候选积压队列
- [√] 3.1 `state.ts` 的 `ContractEntry` 增加 `pendingAudit`；`selectAuditBatch(pending, fresh, limit)` 保证积压优先
- [√] 3.2 `scanner.ts` 把 `--limit` 之外的候选置 `pendingAudit = true`，审计成功/售罄/过期/暂不需审时清除，审计失败保留重试
- [√] 3.3 真链验证：积压 14 → 审计 1 个确为积压目标 → 积压 13

## 4. 局部扫描标注
- [√] 4.1 `score.ts` 的 `assessRisk` 增加 `scanCoverage`/`scanTokens`：集中度标签要求覆盖率 ≥50% 且样本 ≥50 枚，否则标 `partial scan (x% of mints)`
- [√] 4.2 `audit.ts` 计算覆盖率（基点法避免精度问题）并传入；`report.ts` 的分阶段行追加 `(partial scan: x/y)`

## 5. 测试
- [√] 5.1 `tests/scan.cjs` 补自适应二分（mock RPC：宽窗口报密集错误、半窗口成功，断言 3 次调用与拆分边界）与 `selectAuditBatch` 用例
- [√] 5.2 `tests/audit.cjs` 补覆盖率用例（完整/局部/样本过小）
- [√] 5.3 `npm run build` 与 `node --test tests/*.cjs` 通过（44/44，新增 3 例）

## 6. 文档
- [√] 6.1 更新 `README.md`（发现窗口/积压/局部扫描/串行说明）、`helloagents/wiki/modules/scan.md`、`modules/audit.md`、`wiki/data.md`、`CHANGELOG.md`

---

## 执行总结

**结果:** 13/13 完成。`npm run build` 通过，`node --test tests/*.cjs` **44/44**（新增 3 例）。

**修复前后对照（真链）：**

| 场景 | 修复前 | 修复后 |
|---|---|---|
| `--scan --chain robinhood --since-days 1` | ❌ `logs matched by query exceeds limit of 10000`（游标未落盘） | ✅ 86 窗口 / 614 合约 / 5 分 14 秒（纯公共 RPC） |
| `--scan --chain arc --since-days 0.25` | 未验 | ✅ 9 窗口 / 139 合约 / 52 秒 |
| 局部扫描风险标签 | 5 个 token 里 80% 即标 "top minter holds 80%" | 覆盖率 <50% 时改标 `partial scan (x% of mints)`；阶段行标注 `(partial scan: x/y)` |
| 超限候选 | 静默丢弃，下轮不再出现 | 写入 `pendingAudit`，下轮优先；真链验证积压 14→13 且被审目标确为积压项 |

**偏离点:** 除报告建议的 10k 发现窗口外，Robinhood 并发也降为串行（10k 窗口 + 并发 2 在 1 天回填时仍被 429 打断）；发现阶段重试上限提到 8。报告建议的 `mintScan.totalTokens ≥ 50` 与覆盖率判据同时采用。

**未做（按报告留待 M3）:** 队列热加载、静态看板、地板价回填。

---

## 任务状态符号
- `[ ]` 待执行
- `[√]` 已完成
- `[X]` 执行失败
- `[-]` 已跳过
- `[?]` 待确认
