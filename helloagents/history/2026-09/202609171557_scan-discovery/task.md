# 任务清单: 发现器 `--scan`（M2）

目录: `helloagents/plan/202609171557_scan-discovery/`

---

## 1. 状态层
- [√] 1.1 新增 `src/scan/state.ts`：类型（`ScanState`/`ChainCursor`/`ContractEntry`）、`loadState`（损坏回退空状态）、`saveState`（临时文件 + rename 原子写）、`appendHistory`（JSONL），验证 why.md#[需求-状态与快照]-[场景-增量扫描-有游标]
- [√] 1.2 在 `src/scan/state.ts` 实现纯函数 `recordContracts`（新合约/更新 lastSeenBlock）与 `advanceCursor`，验证 why.md#[需求-状态与快照]-[场景-首次扫描-无游标]

## 2. 发现与过滤
- [√] 2.1 新增 `src/scan/scanner.ts`：`discoveryTopics()`（`PublicDropUpdated` OR `SeaDropMint`）与 `isCandidateDrop(drop, nowSec, horizonHours)`、`shouldAudit(entry, eventSinceAudit, startAtMs, nowMs, horizonMs, reauditMs)` 纯函数，验证 why.md#[需求-发现新目标]-[场景-候选过滤与审计]，依赖任务1.2
- [√] 2.2 在 `src/scan/scanner.ts` 实现 `runScan(opts, hooks)`：读状态 → 计算 `from/to`（首次按 `--since-days`，增量从游标，`to = latest − 64`）→ `events.scanLogs` 单例 OR 主题 → 按 `topic1` 去重 → 先落盘发现 → 候选过滤 → 按 `--limit` 进入 `auditTarget` → 写 history → 游标前进，验证 why.md#[需求-发现新目标]-[场景-增量扫描-有游标]，依赖任务2.1

## 3. CLI
- [√] 3.1 新增 `src/scan/cli.ts`：解析 `--scan` 参数（多链、since-days、horizon-hours、limit、lookback-days、grade、export、force、quantity、max-price、json、no-audit），渲染扫描摘要 + M1 表格 + 导出，验证 why.md#[需求-发现新目标]-[场景-候选过滤与审计]，依赖任务2.2
- [√] 3.2 在 `src/index.ts` 增加 `--scan` 分支并更新 HELP，依赖任务3.1
- [√] 3.3 `.gitignore` 增加 `.scan-state.json`、`.scan-history.jsonl`

## 4. 安全检查
- [√] 4.1 执行安全检查：只读调用、状态文件无密钥、状态损坏不致命、导出不覆盖（`--force`）、扫描/审计有窗口与数量上限

## 5. 文档
- [√] 5.1 新增 `helloagents/wiki/modules/scan.md`；更新 `overview.md`（模块索引）、`arch.md`（架构图 + ADR-13~15）
- [√] 5.2 更新 `README.md`（`--scan` 用法与 cron 建议）、`helloagents/CHANGELOG.md`、`wiki/data.md`（状态文件模型）

## 6. 测试
- [√] 6.1 新增 `tests/scan.cjs`：`advanceCursor`（首次/增量/确认延迟）、`isCandidateDrop` 边界、`shouldAudit` 四种分支、状态读写与损坏回退
- [√] 6.2 真链冒烟：`--scan --chain arc --since-days 0.03 --limit 2` 与 `--scan --chain robinhood --since-days 0.2 --limit 2`，确认发现 → 候选 → 审计 → 游标落盘
- [√] 6.3 运行 `npm run build` 与 `node --test tests/*.cjs`，确认现有 35 例不回归

---

## 执行总结

**结果:** 13/13 任务完成。`npm run build` 通过，`node --test tests/*.cjs` **41/41**（新增 6 例）。

**真链冒烟（只读）：**

| 运行 | 结果 |
|---|---|
| Arc 首次（2 窗口 ≈43 分钟） | 发现 36 个合约（36 新）；跳过 ended 1、售罄 1、超 limit 32；审计 2（其中 1 个被限流打断，下次自动重试） |
| Arc 增量（1 窗口） | 发现 6（3 新）；审计 2 均 A：`THE FARCE` 780 剩余、`sharclings` 7601 剩余并**准确标出"开售前 2 分钟改价"**（该目标价格从免费改为 0.05） |
| Robinhood 首次（2 窗口 ≈2 小时） | 发现 136 个合约；跳过 ended 18、超 horizon 5、售罄 4、超 limit 107；审计 2 均 A |

**执行中的调整（偏离点，已同步 wiki/CHANGELOG）：**

1. Arc 扫描并发由 2 降为 **1**（`SCAN_CONCURRENCY.arc`），限流错误退避上限提高到 15s——否则 Arc 公共 RPC 会打断审计。
2. 候选过滤由 `fetchPublicDrop` 改为 **`buildLocalMintPlan`**：后者等价于"脚本能否真正构造出交易"，实测能过滤掉 fee recipient 不可解析的合约。
3. `--limit` 截断的候选新增 `over limit` 计数，避免统计缺口（首版冒烟暴露出 32 个候选未被计入）。
4. 审计支持分数天回看，scan 默认 **0.5 天**（Arc 7 天召回需要 23.7 万级窗口，不可接受）。
5. 重构出 `exportByChain()` 供 `--audit` 与 `--scan` 共用，去掉重复的按链分组导出代码。

**未做（明确留待 M3）：** 单文件 HTML 报告 / 本地看板；mint 后 24/72h 地板价回填与评分权重校准。

---

## 任务状态符号
- `[ ]` 待执行
- `[√]` 已完成
- `[X]` 执行失败
- `[-]` 已跳过
- `[?]` 待确认
