# 变更提案: 目标审计器 `--audit`（M1）+ 批量前置审计（M1.5）

## 需求背景

连续三次实战失败都不是"抢得不够快"，而是**目标本身没有货或临时变卦**：

- Stock Salesman：供应 2,222 在公售前被白名单吃光（链上实测 2,222/2,222，最后铸造早于公售 1.3 小时）
- HoodMiners / Exit Founders：同样在公售前 1–2 小时售罄，脚本在开售首块发送并 revert
- Catonchain：owner 在开售前极短时间改价

同时，用户拿到一份外部方案（`opsea-desgin4.md`）：链上事件发现 + OpenSea Drops API 补全 + 规则打分 + 看板/导出。经逐项核验（见 how.md 的核验附录），其数据源判断大体成立，但有四个必须修正的点，且方向顺序需要调整：

1. `drops/{slug}` 需要 API key，而免费 key **每 IP 每天限 2 个**且会过期；`collections/{slug}` 无 key 可用但会被限流（实测第二次批量请求即 401）。
2. headroom 用 `allowlist_wallet_count × max_per_wallet` 是远离实际的上界：Stock Salesman 有 5,330 个白名单名额，实际只有 2,111 个地址铸到（且其中 111 个由单个地址一笔铸出）。
3. 存储用 `better-sqlite3` 会引入原生编译依赖，破坏仓库现有的"Windows 一键安装 + 4 个纯 JS 依赖"特性。
4. 用 `PublicDropUpdated` 事件"次数"衡量项目方稳定性会误判：HoodMiners 有 4 次事件但语义零变化，Stock Salesman 6 次里只有 3 次真的改了开售时间。

结论：**把审计做成 M1、发现器（扫描新 drop）后置为 M2**。用户过去的失败都发生在已知目标上，审计才是止血点；而审计的两个核心判据（公售有没有货、有没有临时改参数）可以完全由链上数据算出，不依赖 OpenSea。

## 变更内容

1. 新增 `src/audit/` 模块：目标体检（链上状态 + 事件历史 + 可选 OpenSea 增强 + 打分）。
2. 新增 CLI：`npm start -- --audit <slug|合约|文件>... [--export targets.<chain>.json] [--grade A,B]`。
3. 新增事件扫描原语：`SeaDropMint`（单例事件，带 `dropStageIndex`）与 `PublicDropUpdated` 的分窗口扫描，含重试/退避/游标缓存。
4. 导出 `targets.<chain>.json` 并复用 `loadBatchConfig` 校验；`quantity`/`maxPriceEth` 由用户显式给，不按预算推断。
5. **M1.5（止血点）**：批量模式在开售前 `auditBeforeMs`（默认 30 分钟）重跑审计，等级 C 时跳过该目标；失败时放行（fail-open），仍由 T-3s 的 `getMintStats` 兜底。
6. 知识库与 README 同步。

## 影响范围

- **新增模块:** `src/audit/`（audit / events / score / report）
- **新增文件:** `src/audit/*.ts`、`tests/audit.cjs`、`tests/fixtures/audit-*.json`
- **修改文件:** `src/index.ts`（`--audit` 分支）、`src/batch-runner.ts`（auditBeforeMs 接入）、`src/batch-config.ts`（配置字段）、`.gitignore`（`.audit-cache/`）、`README.md`、`helloagents/wiki/*`
- **API:** 内部导出 `auditTarget()`、`scanSeaDropMints()`、`scanPublicDropUpdates()`、`gradeTarget()`
- **数据:** `targets.json` 增加可选 `auditBeforeMs`；本地缓存 `.audit-cache/<chain>/<contract>.json`（不入库）
- **不做（本包范围外）:** M2 发现器（`--scan`）、M3 看板与地板价回填

## 核心场景

### 需求: 目标审计
**模块:** audit

#### 场景: 审计一个已知目标
输入 OpenSea 链接/slug/合约地址（可多个、可混链，文件用 `@watchlist.txt`）。
- 输出一行结果：链、名称、公售开始（UTC+8）、单价、每钱包上限、链上剩余（max−minted）、上界余量、按实测速率的预计余量、预售各阶段已铸/速率/独立地址/Top 集中度、配置变更史（价格/时间/上限各自的变更次数与最近一次）、可选社交信息
- 给出等级 A/B/C/D 与一句话原因
- `.env` 有 `OPENSEA_API_KEY` 时附加 `drops` 阶段名额与 `collections` 社交/创建日期；没有 key 不影响等级判定

#### 场景: 导出批量配置
`--audit ... --export targets.robinhood.json --grade A,B`
- 按链分文件；`slug` 写合约地址；`startAt: "auto"`；`quantity`/`maxPriceEth` 由用户显式给
- 导出后立即用 `loadBatchConfig` 校验并打印 BATCH SCHEDULE 预览，校验失败的目标剔除并说明原因

#### 场景: 已知失败案例的验收
对 Stock Salesman / HoodMiners / Exit Founders 运行审计。
- 必须判 C，并给出链上证据（如 "2222/2222 已铸，最后铸造早于公售 1.3h"）

### 需求: 批量前置审计（M1.5）
**模块:** batch-runner

#### 场景: 开售前 30 分钟自动复检
`targets.json` 设置 `auditBeforeMs`（默认 1800000）。
- 到达 `start − auditBeforeMs` 时重跑审计，打印等级与原因
- 等级为 C（可选配置 D）→ 标记 `SKIPPED`，不进入 T-3s 签名流程
- 审计本身报错（RPC/API 不可用）→ 打印警告并继续（fail-open），保留 T-3s 的 `getMintStats` 兜底
- `auditBeforeMs: 0` 完全关闭该行为

## 风险评估

- **风险:** 投影误杀——按速率推算"开售前必然售罄"但实际有余量，导致跳过本可成功的目标。**缓解:** 只在高置信度时判 C（已铸满，或速率样本 ≥10 分钟且 ≥20 笔、且预计余量 ≤0）；速率不足以支撑判断时降级为 B 并提示；`auditBeforeMs: 0` 可关闭。
- **风险:** OpenSea 限流/无 key 导致增强信息缺失。**缓解:** 增强信息不参与等级判定；缓存与退避；401/429 只降级不报错。
- **风险:** 日志扫描把公共 RPC 打满。**缓解:** 窗口上限（Robinhood 100k、Arc 5k）、串行/低并发 + 指数退避、游标增量、7 天回溯上限、结果按合约缓存；实测 40×100k 窗口并发时约 17% 失败，必须重试。
- **风险:** 缓存过期导致审计基于旧数据。**缓解:** 缓存 TTL（如 5 分钟）+ 审计时强制刷新最近 N 个区块。
- **风险:** 事件解码错误。**缓解:** `SeaDropMint` 的 indexed 布局已实测确认并写成 fixture 测试；非 ERC721SeaDrop 只降级不阻塞。
- **风险:** 批量模式默认多等 30 分钟（多一次唤醒）与多一次审计开销。**缓解:** 默认仅在配置了 `auditBeforeMs` 时启用；单目标开销 <5 秒。
