# 任务清单: 目标审计器 `--audit`（M1）+ 批量前置审计（M1.5）

目录: `helloagents/plan/202609171426_target-audit/`

本包只覆盖 M1 与 M1.5；M2 发现器与 M3 看板另立方案包。

---

## 1. 事件扫描原语
- [√] 1.1 新增 `src/audit/cache.ts`：`.audit-cache/<chain>/<contract>.json` 读写、TTL 与游标（scannedToBlock/scannedAt），验证 why.md#[需求-目标审计]-[场景-审计一个已知目标]
- [√] 1.2 新增 `src/audit/events.ts`：`SeaDropMint` / `PublicDropUpdated` ABI 常量（含实测确认的 indexed 布局），按链窗口上限（Robinhood 100k / Arc 5k）分片扫描，2 并发 + 指数退避（≤4 次），依赖任务1.1
- [√] 1.3 在 `src/audit/events.ts` 实现 `scanSeaDropMints()`（按 `dropStageIndex` 聚合 tx/铸出/独立地址/Top 集中度/首末区块）与 `scanPublicDropUpdates()`（解码后按 price/startTime/cap 去重为语义变更序列），验证 why.md#[需求-目标审计]-[场景-审计一个已知目标]，依赖任务1.2

## 2. 审计编排
- [√] 2.1 新增 `src/audit/audit.ts`：`auditTarget(input, opts)` 并行取链上数据（`buildLocalMintPlan`/`getPublicDrop`/`getMintStats(0x0)`/逐钱包 `getMintStats`/`getSigners`/`getAllowedFeeRecipients`/`name`），失败逐项降级不抛错，验证 why.md#[需求-目标审计]-[场景-审计一个已知目标]，依赖任务1.3
- [√] 2.2 在 `src/audit/audit.ts` 合并事件结果与可选 OpenSea 增强（有 `OPENSEA_API_KEY` 才调用 `collections`/`drops`，401/429 只降级），产出 `AuditResult`，验证 why.md#[需求-目标审计]-[场景-审计一个已知目标]，依赖任务2.1

## 3. 打分
- [√] 3.1 新增 `src/audit/score.ts`：纯函数 `headroomUpperBound`、`projectHeadroom`、`gradeTarget`、`explain`，含 `rateConfident` 保护与"无 API 不判 D"下限，验证 why.md#[需求-目标审计]-[场景-审计一个已知目标]，依赖任务2.2
- [√] 3.2 在 `src/audit/score.ts` 实现风险标签（开售前 60 分钟内改价/改期、start 变更次数、Top 地址占比、无社交）与 D 级组合判定，验证 why.md#[需求-目标审计]-[场景-审计一个已知目标]，依赖任务3.1

## 4. 报告与导出
- [√] 4.1 新增 `src/audit/report.ts`：按开售时间排序的表格渲染（含上界/实测两个余量与各自等级、⚠ 标签、一句话原因），`--json` 结构化输出，验证 why.md#[需求-目标审计]-[场景-审计一个已知目标]，依赖任务3.2
- [√] 4.2 在 `src/audit/report.ts` 实现 `--export targets.<chain>.json`（`slug`=合约地址、`startAt:"auto"`、`quantity`/`maxPriceEth` 显式），导出后调 `loadBatchConfig` 校验并打印 BATCH SCHEDULE 预览，失败目标剔除并说明，验证 why.md#[需求-目标审计]-[场景-导出批量配置]，依赖任务4.1

## 5. CLI
- [√] 5.1 在 `src/index.ts` 增加 `--audit` 分支（支持多目标、`@文件`、`--wallets`、`--lookback-days`、`--export`、`--grade`、`--json`）并更新 HELP，验证 why.md#[需求-目标审计]-[场景-审计一个已知目标]，依赖任务4.2

## 6. 批量前置审计（M1.5）
- [√] 6.1 在 `src/batch-config.ts` 解析 `auditBeforeMs`（默认 1800000，0 关闭）与 `auditSkipGrades`（默认 `["C"]`），验证 why.md#[需求-批量前置审计-m1-5]-[场景-开售前-30-分钟自动复检]
- [√] 6.2 在 `src/batch-runner.ts` 逐目标循环内、调用执行器之前接入审计：等到 `start − auditBeforeMs` → 审计 → 命中 `auditSkipGrades` 记 SKIPPED 并 continue；审计抛错仅告警并继续（fail-open）；过点则立即审计并提示，验证 why.md#[需求-批量前置审计-m1-5]-[场景-开售前-30-分钟自动复检]，依赖任务6.1、5.1

## 7. 安全检查
- [√] 7.1 执行安全检查：仅只读调用、不打印/不落盘 `OPENSEA_API_KEY`、`.audit-cache/` 与导出文件不含密钥、RPC 并发与重试有上限、导出文件不覆盖已有配置（写入前确认）

## 8. 文档
- [√] 8.1 新增 `helloagents/wiki/modules/audit.md`；更新 `overview.md`（模块索引）、`arch.md`（架构图 + ADR-8~12 索引）
- [√] 8.2 更新 `README.md`（`--audit` 用法与输出示例、`auditBeforeMs` 说明）、`.gitignore`（`.audit-cache/`）、`helloagents/CHANGELOG.md`

## 9. 测试
- [√] 9.1 新增 `tests/audit.cjs`：`score.ts` 全部纯函数（A/B/C/D、未知 maxSupply、rateConfident 保护、无 API 不判 D、lastMinute 标签）；`SeaDropMint` 解码用真实 log fixture（`tests/fixtures/seadropmint-arc.json`）
- [√] 9.2 新增窗口分片/退避决策测试（注入假 RPC，断言分片边界与重试次数），验证 why.md#[风险评估]
- [?] 9.3 真链验收（只读）：Stock Salesman / HoodMiners / Exit Founders 必须判 C 且证据正确；Catonchain（合约地址待提供）判 A/B 且带改价 ⚠；记录实际输出到 task.md 执行总结
  > 备注: 三个已知失败案例已验收通过（见执行总结）；Catonchain 未提供合约地址，该项待补
- [√] 9.4 运行 `npm run build` 与 `node --test tests/*.cjs`，确认现有 25 例不回归

---

## 执行总结

**结果:** 15/17 任务完成，1 项待用户补充输入（Catonchain 合约地址），0 项失败。`npm run build` 通过，`node --test tests/*.cjs` **35/35** 通过（新增 10 例）。

**真链验收（只读，Robinhood 公共 RPC，3 天回溯）：**

| 目标 | 等级 | 上界 / 投影 | 链上证据 |
|---|---|---|---|
| Stock Salesman | **C** | C / C | minted 2222/2222；阶段 #1 111（1 地址）、#2 1478、#3 633；变更史 7 条（3 天内无价格/时间变更） |
| HoodMiners | **C** | C / C | minted 5000/5000；阶段 #1 250（1 地址）、#2 3926、#3 824 |
| Exit Founders | **C** | C / C | minted **4444**/4444（不是 `totalSupply()` 的 3697）；阶段 #1 1111（1 地址）、#2 3317、#3 16 |

**Arc 验收与导出：** `0x5F26e267…B751`（sharclings，免费，cap 3）判 **A**（上界 8905、按近 15 分钟速率预计 7366），`--export` 产出经 `loadBatchConfig` 校验的文件并打印 BATCH SCHEDULE 预览。

**执行中的调整（偏离点）：**

1. 缓存为 **TTL（5 分钟）整段重扫**，`scannedToBlock` 已写入但未用于增量合并（合并需保存 minter 明细，收益低）；ADR-11 的"游标"部分留待 M2。
2. 扫描默认并发由 3 降为 **2**：真链实测 Robinhood 公共 RPC 在 3 并发 × 2 类扫描并行时频繁 429（重试均成功）；2 并发明显减少重试。
3. 新增一处计划外修复（Arc review 的尾巴）：`wizard.ts` gas 环境变量改为 trim 判空，与 `resolveGas` 一致；`CHANGELOG` 与 `modules/wizard.md` 已记录。
4. `SeaDropMint` 的 indexed 布局用真实日志反解确认（3 个 indexed），并落为 fixture 测试；外部 review 指出的 `drops` 字段与阶段名额（111 为单地址一笔）已被链上数据交叉验证。

**未做（明确留待后续）：** M2 `--scan` 发现器、M3 看板与地板价回填；Catonchain 验收。

---

## 任务状态符号
- `[ ]` 待执行
- `[√]` 已完成
- `[X]` 执行失败
- `[-]` 已跳过
- `[?]` 待确认
