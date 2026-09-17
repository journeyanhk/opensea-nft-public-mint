# 任务清单: M3 扫描→执行闭环（M3a → M3b → M3c）

目录: `helloagents/plan/202609171655_m3-pipeline/`

按报告调整后的顺序执行：M3a 热加载（让 M2 产出落地）→ M3b 静态看板 → M3c 地板价回填。

---

## 1. M3a 执行账本与热加载
- [√] 1.1 新增 `src/batch-ledger.ts`：`.batch-state.json` 读写（原子写）、`record()`、`statusOf()`、纯函数 `shouldSkipLedger(entry, { retryPending })`，验证 why.md#[需求-m3a-队列热加载]-[场景-进程重启不重复-mint]
- [√] 1.2 新增 `src/batch-watch.ts`：`mergeRawConfigs(files)`（按 slug/地址小写去重、主配置优先）、`diffKeys()`、`rawTargetKey()`，验证 why.md#[需求-m3a-队列热加载]-[场景-扫描导出的新目标自动进入队列]，依赖任务1.1
- [√] 1.3 在 `src/batch-runner.ts` 抽出队列模型与 `enqueue()`，逐目标循环改为队列消费；首轮行为保持不变（含单次确认），验证 why.md#[需求-m3a-队列热加载]-[场景-扫描导出的新目标自动进入队列]
- [√] 1.4 在 `src/batch-runner.ts` 实现 `--watch` 轮询：重读配置 → 合并 → 解析校验（`loadBatchConfig`，quiet 模式避免重复告警）→ 逐目标余额预检 → 入队；文件读取失败保留上一版并告警；等待期间分片轮询，验证 why.md#[需求-m3a-队列热加载]-[场景-扫描导出的新目标自动进入队列]，依赖任务1.2、1.3
- [√] 1.5 在 `src/index.ts` 增加 `--watch`、`--watch-interval <秒>`、`--no-ledger`、`--retry-pending` 并更新 HELP；`.gitignore` 增加 `.batch-state.json`，依赖任务1.4
- [√] 1.6 账本写入时机：广播前写 `PENDING`，收到结果后更新；`txHash` 非空一律跳过，验证 why.md#[需求-m3a-队列热加载]-[场景-进程重启不重复-mint]，依赖任务1.1、1.4
- [√] 1.7 `exportTargets` 改为先写临时文件再 rename，避免 watch 读到半写文件，依赖任务1.4

## 2. M3b 静态看板（未开始）
- [ ] 2.1 新增 `src/scan/html.ts`：`loadDashboardRows(state, history)` 组装行（最新等级 + 变化序列）与 `renderDashboard(rows, meta)` 生成单文件 HTML（内联 CSS/JS、全字段转义、等级/链筛选、排序、勾选生成短名单与命令）
- [ ] 2.2 在 `src/scan/cli.ts` 增加 `--report <out.html>`（可与 `--scan` 同时用：先扫描再生成），更新 HELP
- [ ] 2.3 补 `renderDashboard` 用例：HTML 转义（名称含 `<script>`）、排序、筛选标记

## 3. M3c 地板价回填（未开始）
- [ ] 3.1 新增 `src/scan/backfill.ts`：`dueCheckpoints(ledger, feedback, now, horizons)` 纯函数选出到期目标；`runBackfill(opts)` 反查 slug（账本已存则直接用）→ 拉 `collections/{slug}/stats` → 追加 `.feedback.jsonl`；无 key/401/429 跳过并计数
- [ ] 3.2 账本条目在 M3a 写入时一并保存 `slug`（已完成，见任务1.1/1.6），依赖任务1.6
- [ ] 3.3 在 `src/index.ts` 增加 `--backfill`、`--backfill-after <小时列表>` 并更新 HELP；`.gitignore` 增加 `.feedback.jsonl`
- [ ] 3.4 补 `dueCheckpoints` 单测（未到期/已回填/多时点）

## 4. 安全检查
- [√] 4.1 M3a 部分：账本不含密钥、watch 只读显式路径、原子写、重复 mint 保护（txHash 规则）、审计失败不阻断
- [ ] 4.2 M3b/M3c 部分：HTML 全字段转义、回填失败不终止且不写密钥

## 5. 文档
- [√] 5.1 新增 `helloagents/wiki/modules/batch-watch.md`；更新 `overview.md`（模块索引）、`modules/batch.md`、`wiki/data.md`、`README.md`、`CHANGELOG.md`
- [ ] 5.2 新增 `helloagents/wiki/modules/feedback.md`（M3c）并更新 `arch.md`（架构图 + ADR-16~18；ADR-16/17 已实现但待 M3b/M3c 一起入索引）

## 6. 测试与验收
- [√] 6.1 `tests/batch-watch.cjs`：`mergeRawConfigs` 去重与优先级、`diffKeys`、`rawTargetKey`、账本往返、`shouldSkipLedger` 全状态覆盖
- [ ] 6.2 真链验收 M3a（发送）：需要已充值钱包——用扫描导出的免费目标在 watch 下自动执行一笔，重启后确认账本阻止重发
  > 备注: 无资金路径已验证（见执行总结）；真实发送待用户钱包
- [ ] 6.3 真链验收 M3b：用真实 `.scan-state.json` 生成 HTML 并人工打开确认
- [ ] 6.4 真链验收 M3c：有 key 时回填一笔历史 SUCCESS；无 key 时提示明确且不报错
- [√] 6.5 `npm run build` 与 `node --test tests/*.cjs` 通过（**52/52**，新增 5 例）

---

## M3a 执行总结（本次）

**结果:** 任务 1.1–1.7、4.1、5.1、6.1、6.5 完成；M3b/M3c 未开始。`npm run build` 通过，`node --test tests/*.cjs` **52/52**。

**无资金集成验证**（Arc 公共 RPC，随机空钱包，`--max-polls 2`）：

```
1 target(s) already handled per the ledger          ← 账本跳过
no actionable targets — nothing to fund             ← 只对可执行目标做余额预检
  › Run this batch unattended and watch for new targets? (y/N): y
✗ 0x5F26…B751 skipped — 0xaefD…3F3B cannot cover 0.06 USDC yet   ← 热加载合并 + 逐目标余额拦截
watch stopped after 2 poll(s)
### ledger entries: 1                                ← 未执行的目标不写账本
```

**关键行为:** `--watch` 期间注入新目标被检测并合并；合格者入队、不合格者记录跳过；队列空时持续轮询；进程内重复目标按合约去重；`PENDING` 记账先于发送（崩溃也不会重发）。

**未验证:** 真实广播（需要已充值钱包）；`M3b/M3c` 全部；`arch.md` 的 ADR-16/17 索引（待 M3 整体完成后随方案包迁移一起补）。

---

## 任务状态符号
- `[ ]` 待执行
- `[√]` 已完成
- `[X]` 执行失败
- `[-]` 已跳过
- `[?]` 待确认
