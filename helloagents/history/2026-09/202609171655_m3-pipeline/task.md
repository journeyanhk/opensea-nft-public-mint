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

## 2. M3b 静态看板
- [√] 2.1 新增 `src/scan/html.ts`：`loadDashboardRows(state, history, ledger, cacheLoader)` 组装行（最新等级 + 变化序列 + 执行结果 + 分阶段/风险标注）与 `renderDashboard(rows, meta)` 生成单文件 HTML（内联 CSS/JS、全字段转义、等级/链筛选、排序、搜索、勾选生成短名单与命令）
- [√] 2.2 在 `src/scan/cli.ts` 增加 `--report <out.html>`（单独用或接在 `--scan` 后），并支持 `--state/--history/--ledger` 覆盖；更新 HELP
- [√] 2.3 新增 `tests/dashboard.cjs`：历史解析（容错半行）、状态/历史/账本/缓存合并、降级（无缓存/无账本）、HTML 转义（合约与名称含 `<script>`）
- [√] 2.4 真链验收：33 个真实目标生成 24KB 单文件 HTML，行数/等级徽标/短名单/无外部资源/等级轨迹全部核对通过；
  > 备注: 浏览器人工打开确认待你在本机执行（生成命令见 README）

## 3. M3c 地板价回填
- [√] 3.1 新增 `src/scan/backfill.ts`：`dueCheckpoints(ledger, feedback, now, horizons)` 纯函数选出到期目标；`runBackfill(opts)` 反查 slug（账本已存则直接用）→ 拉 `collections/{slug}/stats` → 追加 `.feedback.jsonl`；无 key/401/429 跳过并计数
- [√] 3.2 账本条目在 M3a 写入时一并保存 `slug`（已完成，见任务1.1/1.6），依赖任务1.6
- [√] 3.3 在 `src/index.ts` 增加 `--backfill`、`--backfill-after <小时列表>` 并更新 HELP；记录文件为 `.backfill.jsonl`（已 gitignore）
- [√] 3.4 `tests/backfill.cjs`：到期选择（未到/已记录/非 SUCCESS/多时点）、成本计算、stats 解析、runBackfill 幂等与缺数据重试

## 4. 安全检查
- [√] 4.1 M3a 部分：账本不含密钥、watch 只读显式路径、原子写、重复 mint 保护（txHash 规则）、审计失败不阻断
- [√] 4.2 M3b/M3c 部分：HTML 全字段转义（含注入用例）、回填失败不终止、无 key 只降级、记录不含密钥

## 5. 文档
- [√] 5.1 新增 `helloagents/wiki/modules/batch-watch.md`；更新 `overview.md`（模块索引）、`modules/batch.md`、`wiki/data.md`、`README.md`、`CHANGELOG.md`
- [√] 5.2 新增 `helloagents/wiki/modules/feedback.md`（M3c）；`arch.md` 增加 ADR-16~18 索引

## 6. 测试与验收
- [√] 6.1 `tests/batch-watch.cjs`：`mergeRawConfigs` 去重与优先级、`diffKeys`、`rawTargetKey`、账本往返、`shouldSkipLedger` 全状态覆盖
- [ ] 6.2 真链验收 M3a（发送）：需要已充值钱包——用扫描导出的免费目标在 watch 下自动执行一笔，重启后确认账本阻止重发
  > 备注: 无资金路径已验证（见执行总结）；真实发送待用户钱包
- [?] 6.3 真链验收 M3b：已用真实 `.scan-state.json` 生成 HTML 并核对内容；浏览器人工打开确认待用户执行
- [?] 6.4 真链验收 M3c：链上成本路径已用真实成功 mint 交易验证（cost = 0.000008826 ETH，due/written 正确、幂等由单测覆盖）；OpenSea stats 路径待你的 key（本机 key 端点仍 429）
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

## review6 修复（M3a 收口）

- [√] watch 文件缺失视为空配置（提示 `waiting for <file>`），不再 ENOENT 致命；主配置仍必需
- [√] watch 模式允许空队列启动（`loadBatchConfig({ allowEmpty })`），确认文案改为 "Watch for targets and run them unattended?"
- [√] `REVERTED` 在公售仍开放且 `attempts < 2` 时允许重试（revert 证明未铸出）；账本新增 `attempts` 计数；其余带 `txHash` 的状态仍一律跳过（防御）
- [√] 从配置移除且未执行的目标清理 `known`，等级回升重新导出后可再入队
- [√] 余额不足的新目标每 5 分钟重试（充值后自动入队）——顺手修掉"affordability 与入队分离导致拦截失效"的自引入缺陷
- [√] 端到端验证（Arc 真链，空钱包）：空启动 + 文件后到 → 合并入队 → REVERTED 重试 → 签名/广播被 RPC 以余额不足拒绝（零成本）→ 账本 SKIPPED attempts=2
- 说明：report.ts 导出的 tmp+rename 原子写已在 M3a 首次提交中实现（review 第 5 条无需再改）

## M3b + M3c 执行总结

**结果:** 除两项待用户执行（浏览器打开看板、带 key 的 stats 回填）外全部完成。`npm run build` 通过，`node --test tests/*.cjs` **62/62**（M3b 新增 5 例、M3c 新增 5 例）。

**M3b 静态看板：** `--report` 生成单文件 HTML（33 个真实目标 / 24KB），风险标注改为读取最近一次审计的 `risks`（写入 `.scan-history.jsonl` 的 `risks/reason/coverage`），短名单命令内联地址，页面 5 分钟自动刷新。

**M3c 回填：** 链上成本路径用真实成功 mint 交易验证——`due 2 / written 2`、`costWei = 8826121200000`（0.000008826 ETH）；幂等与缺数据重试由单测覆盖。

**关键偏离（有实测依据）：** review7 建议以 Seaport 1.6 `OrderFulfilled` 链上成交为主数据源，实测 Robinhood 最近 600 万块（约 7 天）与 Arc 最近 17 万块（约 24 小时）均为 **0 条成交**——两条链没有可读的二级市场。因此 M3c 以 **OpenSea stats 为地板价唯一来源**（无 key 时降级），链上只负责真实成本。

**未验证：** OpenSea stats 的字段解析（本机 key 创建端点持续 429）；请在你自己环境跑一次 `npm start -- --backfill` 校验。

## 任务状态符号
- `[ ]` 待执行
- `[√]` 已完成
- `[X]` 执行失败
- `[-]` 已跳过
- `[?]` 待确认
