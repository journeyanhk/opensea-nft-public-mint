# 任务清单: M5a 面板基础事实与需求信号

目录: `helloagents/plan/202609181634_m5a-panel-facts/`

---

## 1. 审计补齐事实
- [√] 1.1 `src/audit/events.ts`：`aggregateMints(logs, recentFromBlock, extraCutoffs)` 支持多窗口，`MintScan` 增加 `recentByWindow`，验证 why.md#[需求-速度与序列]-[场景-刚开售的目标]
- [√] 1.2 `src/audit/audit.ts`：计算 15m/1h 起始块并传入；读取 `owner()`（失败容忍）；`AuditResult` 增加 `owner` 与 `recentByWindow`（含序列化/反序列化与缓存兼容），依赖任务1.1

## 2. 历史与复审
- [√] 2.1 `src/scan/scanner.ts`：历史记录写入 `name/owner/mintPriceWei/capPerWallet/endTime/maxSupply/totalMinted/recent15m/recent1h/uniqueMinters/topMinterShare/stageCount/presaleStages`，验证 why.md#[需求-面板能看懂]-[场景-一行看清一个目标]，依赖任务1.2
- [√] 2.2 `src/scan/scanner.ts`：`shouldAudit` 增加"开售 72h 内每 30 分钟复审"（常量 `REAUDIT_OPENED_HOURS`）；候选排序改为 积压 > 最久未审的已开售 > 新发现/临近，验证 why.md#[需求-速度与序列]-[场景-开售一段时间的目标]，依赖任务2.1

## 3. 面板字段与筛选
- [√] 3.1 `src/scan/html.ts`：纯函数 `velocityPer24h` / `staleVerdict` / `sellOutEtaHours`，`GradePoint` 带 `minted`，`DashboardRow` 增加名称/owner/价格/上限/结束时间/已铸/15m/1h/地址数/预售/24h 速度（含来源）/售罄预计/陈旧/链接，验证 why.md#[需求-速度与序列]-[场景-开售一段时间的目标]，依赖任务2.1
- [√] 3.2 `src/scan/html.ts`：表格新增列（名称、FREE·价格、上限、窗口倒计时、已铸进度、15m、1h、地址数、预售、24h 速度、售罄预计、链接）与"免费 · A/B · 隐藏陈旧"预设、陈旧默认隐藏与计数、显示陈旧开关；`data-*` 支持排序与过滤，验证 why.md#[需求-面板能看懂]-[场景-一键收窄候选]，依赖任务3.1
- [√] 3.3 `src/serve/server.ts`：`/api/rows` 支持 `?stale=` 参数（与前端一致），依赖任务3.2

## 4. 安全检查
- [√] 4.1 执行安全检查：新字段渲染全部 `escapeHtml`；链接仅来自链注册表（不受外部输入影响）；`/api/rows` 不泄露新敏感信息

## 5. 文档
- [√] 5.1 更新 `helloagents/wiki/modules/scan.md`（历史字段与复审策略）、`modules/audit.md`（owner 与速度桶）、`wiki/data.md`（历史字段表）
- [√] 5.2 更新 `README.md`（面板列与预设说明、M5a 观察期建议）与 `CHANGELOG.md`

## 6. 测试与验收
- [√] 6.1 `tests/audit.cjs` / `tests/scan.cjs`：多窗口聚合、`shouldAudit` 已开售复审与 30 分钟节流
- [√] 6.2 `tests/dashboard.cjs`：`velocityPer24h`（差分/回退/缺口）、`staleVerdict` 边界、`sellOutEtaHours`、历史字段往返、渲染断言（FREE/stale/隐藏计数/链接）
- [√] 6.3 真链验收：`--scan --chain robinhood --limit 3` 检查历史新字段；`--serve` 页面出现新列与陈旧计数
- [√] 6.4 `npm run build` 与 `node --test tests/*.cjs` 通过（现有 74 例不回归）

---

## 执行总结

**结果:** 18/18 完成。`npm run build` 通过，`node --test tests/*.cjs` **79/79**（新增 5 例：多窗口聚合、已开售复审与节流、速度差分/回退、陈旧边界、新字段渲染）。

**真链验证（Robinhood，3 个目标，0.5 天回看）：**

| 目标 | 历史行新字段实测 |
|---|---|
| ANIMATED PUNKS | name/owner/price 0.0007/cap 30/minted 1311÷5555/minters 49/top 2%/pre 0 |
| The Standard Reserve | top 1.0（单地址占 100%）/pre 1 |
| PIXEL BOYS | minted 742÷8888/minters 44 |

`--report` 输出 63 行正常渲染（3 个已审计行带速度、其余为未审计的 `?`）；FREE 徽标与陈旧过滤由单测覆盖（真链样本中恰好没有免费/陈旧目标）。

**说明与后续观察：**

- 旧历史行没有新字段 → 面板显示为空，新审计逐步补齐；开售 72h 内的活跃目标优先（候选排序）。
- 用户要求的"部署观察 2–3 天再定 M5b 的 Q 分权重"正是本包的收尾条件；观察指标建议：896 行经"隐陈旧 + FREE"过滤后剩多少、速度列是否足以区分真实需求。
- M5b 待做：社交（无 key 的 collections）、缩略图（https + seadn.io/opensea.io 白名单）、创作者历史两层（owner 链上代理 + 账本/回填覆盖并标 "own data"）、Q 分与置信度、行展开详情、X 指标 opt-in（M5c：二级成交列与开售冲突警告）。

## 任务状态符号
- `[ ]` 待执行
- `[√]` 已完成
- `[X]` 执行失败
- `[-]` 已跳过
- `[?]` 待确认
