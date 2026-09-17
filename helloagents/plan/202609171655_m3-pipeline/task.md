# 任务清单: M3 扫描→执行闭环（M3a → M3b → M3c）

目录: `helloagents/plan/202609171655_m3-pipeline/`

按报告调整后的顺序执行：M3a 热加载（让 M2 产出落地）→ M3b 静态看板 → M3c 地板价回填。

---

## 1. M3a 执行账本与热加载
- [ ] 1.1 新增 `src/batch-ledger.ts`：`.batch-state.json` 读写（原子写）、`record()`、`statusOf()`、纯函数 `shouldSkipLedger(entry, { retryPending })`，验证 why.md#[需求-m3a-队列热加载]-[场景-进程重启不重复-mint]
- [ ] 1.2 新增 `src/batch-watch.ts`：`mergeRawConfigs(files)`（按 slug/地址小写去重、主配置优先）、`diffQueue(queue, incoming, ledger)`（新增/移除/已完成）、`pruneQueue()`，验证 why.md#[需求-m3a-队列热加载]-[场景-扫描导出的新目标自动进入队列]，依赖任务1.1
- [ ] 1.3 在 `src/batch-runner.ts` 抽出 `executeTarget(target, ctx)`，把逐目标循环改为待执行队列消费；首轮行为保持不变（含单次确认），验证 why.md#[需求-m3a-队列热加载]-[场景-扫描导出的新目标自动进入队列]
- [ ] 1.4 在 `src/batch-runner.ts` 实现 `--watch` 轮询：重读配置 → 合并 → 解析校验（`loadBatchConfig`）→ 余额预检 → 入队；新目标自动执行但必须过 `maxPriceEth` 护栏；文件读取失败保留上一版并告警，验证 why.md#[需求-m3a-队列热加载]-[场景-扫描导出的新目标自动进入队列]，依赖任务1.2、1.3
- [ ] 1.5 在 `src/index.ts` 增加 `--watch`、`--watch-interval <秒>`、`--no-ledger`、`--retry-pending` 并更新 HELP；`.gitignore` 增加 `.batch-state.json`
- [ ] 1.6 账本写入时机：广播前写 `PENDING`，收到结果后更新；`txHash` 非空一律跳过，验证 why.md#[需求-m3a-队列热加载]-[场景-进程重启不重复-mint]，依赖任务1.1、1.4
- [ ] 1.7 `exportTargets` 改为先写临时文件再 rename，避免 watch 读到半写文件，依赖任务1.4

## 2. M3b 静态看板
- [ ] 2.1 新增 `src/scan/html.ts`：`loadDashboardRows(state, history)` 组装行（最新等级 + 变化序列）与 `renderDashboard(rows, meta)` 生成单文件 HTML（内联 CSS/JS、全字段转义、等级/链筛选、排序、勾选生成短名单与命令），验证 why.md#[需求-m3b-静态看板]-[场景-本地查看候选并生成短名单]
- [ ] 2.2 在 `src/scan/cli.ts` 增加 `--report <out.html>`（可与 `--scan` 同时用：先扫描再生成），更新 HELP
- [ ] 2.3 `tests/feedback.cjs` 或 `tests/scan.cjs` 补 `renderDashboard` 用例：HTML 转义（合约名/名称含 `<script>`）、排序、筛选标记

## 3. M3c 地板价回填
- [ ] 3.1 新增 `src/scan/backfill.ts`：`dueCheckpoints(ledger, feedback, now, horizons)` 纯函数选出到期目标；`runBackfill(opts)` 反查 slug（账本已存则直接用）→ 拉 `collections/{slug}/stats` → 追加 `.feedback.jsonl`；无 key/401/429 跳过并计数，验证 why.md#[需求-m3c-地板价回填]-[场景-mint-后-24h-72h-回填]
- [ ] 3.2 账本条目在 M3a 写入时一并保存 `slug`（导出时已知），减少回填阶段的 API 依赖，依赖任务1.6
- [ ] 3.3 在 `src/index.ts` 增加 `--backfill`、`--backfill-after <小时列表>` 并更新 HELP；`.gitignore` 增加 `.feedback.jsonl`
- [ ] 3.4 补 `dueCheckpoints` 单测（未到期/已回填/多时点）

## 4. 安全检查
- [ ] 4.1 执行安全检查：账本/反馈不含密钥、HTML 转义、watch 只读显式路径、回填失败不终止、重复 mint 保护（txHash 规则）

## 5. 文档
- [ ] 5.1 新增 `helloagents/wiki/modules/batch-watch.md`、`modules/feedback.md`；更新 `overview.md`、`arch.md`（架构图 + ADR-16~18）
- [ ] 5.2 更新 `README.md`（常驻扫描 + watch 批量 + 生成看板 + 回填的完整命令序列）、`helloagents/CHANGELOG.md`

## 6. 测试与验收
- [ ] 6.1 `tests/batch-watch.cjs`：`mergeRawConfigs` 去重与优先级、`diffQueue` 三类变更、`shouldSkipLedger` 六种状态 × txHash 覆盖
- [ ] 6.2 真链验收 M3a：扫描导出 → watch 批量自动执行一个已开售的免费目标 → 重启进程确认账本阻止重复发送
- [ ] 6.3 真链验收 M3b：用真实 `.scan-state.json` 生成 HTML 并人工打开确认
- [ ] 6.4 真链验收 M3c：有 key 时回填一笔历史 SUCCESS；无 key 时提示明确且不报错
- [ ] 6.5 `npm run build` 与 `node --test tests/*.cjs` 通过（现有 44 例不回归）

---

## 任务状态符号
- `[ ]` 待执行
- `[√]` 已完成
- `[X]` 执行失败
- `[-]` 已跳过
- `[?]` 待确认
