# 变更提案: M3 扫描→执行闭环（M3a 热加载 → M3b 静态看板 → M3c 地板价回填）

## 需求背景

M1（审计）与 M2（发现）已上线：`--scan` 每 15–30 分钟产出 `targets.scan.<chain>.json`。但实测（M2 review）暴露出**扫描与执行之间没有自动通道**——`--batch` 启动时只读一次配置，扫描新导出的目标必须人工重启批量进程，否则 M2 的产出落不了地。

因此 M3 按报告调整顺序，先补闭环的第一环：

1. **M3a 队列热加载**：`--batch ... --watch` 定期重读配置，合并新目标、去重、移除已结束，并保留已执行状态（含跨重启账本，避免重复 mint）。
2. **M3b 静态看板**：`--report out.html` 从 `.scan-state.json` + `.scan-history.jsonl` 生成单文件 HTML（不需 server），勾选后生成 `@shortlist.txt` 内容与导出命令。
3. **M3c 地板价回填**：对已 mint 的目标在 24h/72h 后拉 `collections/{slug}/stats` 写回反馈账本，两周后再调评分权重。**硬依赖 OpenSea key**（stats 与合约反查 slug 都要 key），需先确认 key 稳定可用。

## 变更内容

1. **执行账本**（M3a 前置）：`.batch-state.json` 记录每个 (chain, contract) 的最后一次执行结果与时间；重启后不重复发送已上链的目标。
2. **`--watch`**（M3a）：`npm start -- --batch targets.robinhood.json --watch [额外配置.json ...]` 每 `--watch-interval`（默认 60s）重读并合并；新目标自动执行（watch 即预授权），但受 `maxPriceEth` 与余额预检约束；已在执行/已完成的目标不重复。
3. **`--report <out.html>`**（M3b）：单文件、内联 CSS/JS 的候选看板；按开售时间排序、等级筛选、风险标签、等级历史；勾选后一键复制 `@shortlist.txt` 与 `--audit` / `--export` 命令。
4. **`--backfill`**（M3c）：从执行账本挑出到期（24h/72h）且未回填的 mint，拉地板价/成交量写入 `.feedback.jsonl`；无 key 或 key 失效时明确跳过。
5. 文档、README、CHANGELOG、知识库同步。

## 影响范围

- **新增:** `src/batch-ledger.ts`、`src/batch-watch.ts`（合并与调度）、`src/scan/html.ts`（HTML 构建）、`src/scan/backfill.ts`、`tests/batch-watch.cjs`、`tests/feedback.cjs`
- **修改:** `src/batch-runner.ts`（执行循环抽出、watch 接入）、`src/index.ts`（`--report`/`--backfill` 分支）、`.gitignore`（`.batch-state.json`、`.feedback.jsonl`）、README、wiki
- **数据:** 新增 `.batch-state.json`、`.feedback.jsonl`（均 gitignore，无密钥）
- **不做:** 本地 web server、自动选目标并自动执行（仍由人勾选/导出）、SQLite

## 核心场景

### 需求: M3a 队列热加载
**模块:** batch

#### 场景: 扫描导出的新目标自动进入队列
批量进程常驻并 `--watch targets.scan.robinhood.json`。
- 每 60 秒重读；新合约（按地址去重）解析 → 余额预检 → 按开售时间插入待执行队列 → 打印一行 `+ 新目标`
- 已在执行的等待不受影响；新目标若开售时间更早则紧接着执行
- 配置中消失且未执行的目标从队列移除并记录；已结束的跳过

#### 场景: 进程重启不重复 mint
进程重启后重读配置。
- 账本中状态为 SUCCESS / REVERTED / TIMEOUT（交易已广播）的目标跳过并说明
- SKIPPED / REJECTED（未上链）允许重试
- `--no-ledger` 可关闭该保护（不推荐）

### 需求: M3b 静态看板
**模块:** scan

#### 场景: 本地查看候选并生成短名单
`npm start -- --report dashboard.html`
- 无网络请求：完全由 `.scan-state.json` + `.scan-history.jsonl` 生成
- 表格列：链、合约/名称、等级（最新）、开售时间、剩余/预计、最近审计时间、风险摘要；支持按等级与链筛选、按开售时间排序
- 勾选后生成 `@shortlist.txt` 内容 + `--audit`/`--export` 命令，一键复制
- 浏览器直接打开，无 server、无外部资源

### 需求: M3c 地板价回填
**模块:** scan

#### 场景: mint 后 24h/72h 回填
定时运行 `npm start -- --backfill`
- 从执行账本取到期且未回填的 SUCCESS 目标，反查 slug → `collections/{slug}/stats` → 追加 `.feedback.jsonl`
- 已有回填记录（同目标同时点）不重复
- 无 `OPENSEA_API_KEY` 或 401/429 时明确提示并跳过（不影响其他目标）

## 风险评估

- **风险:** 热加载自动执行新目标可能超出预期（误导出、恶意目标）。**缓解:** watch 模式下每个新目标仍打印完整参数；`maxPriceEth` 护栏与余额预检必须通过；文档明确"watch 即预授权"；`--watch-interval` 可调大。
- **风险:** 重复 mint 造成资金损失。**缓解:** 执行账本以"是否已广播"为准（txHash 存在即跳过），原子写；`--no-ledger` 需显式关闭。
- **风险:** 看板 HTML 里的合约地址/名称注入。**缓解:** 所有动态字段做 HTML 转义（单测覆盖）。
- **风险:** M3c 的 key 不可用（免费 key 每天限 2 个、会过期）。**缓解:** 回填是纯增益步骤，失败只跳过；文档说明需要用户自有稳定 key；无 key 时整个 M3c 不阻塞 M3a/M3b。
- **风险:** 热加载重读配置时文件半写入（导出正在写）。**缓解:** 读取失败保留上一版配置并告警；`exportTargets` 本身先写临时文件再 rename（M3a 一并加固）。

## 交付顺序与验收

1. **M3a**（先做）：验收——`--watch` 下用扫描导出的文件新增一个已开售的免费目标，批量进程在 ≤1 个 interval 内自动执行；重启进程后账本阻止重复发送。
2. **M3b**：验收——用真实 `.scan-state.json` 生成 HTML，浏览器打开可排序/筛选/勾选复制；转义用例通过。
3. **M3c**：验收——有 key 时对一个历史 SUCCESS 目标回填出地板价；无 key 时给出明确提示且不报错。
