# 怎么做: 监控优先阶段 A

目录: `helloagents/plan/202609191634_monitor-phase-a/`

## 方案总览

```
src/scan/calendar.ts        新增：OpenSea 日历解析（纯函数 + 抓取 + 金丝雀）
src/scan/smart-minters.ts   新增：聪明铸造者集合（纯聚合 + 文件读写）
src/scan/valuation.ts       新增：保守估值护栏（纯函数）
src/scan/state.ts           ContractEntry.calendar/sources + ScanState.calendar 元数据
src/scan/scanner.ts         每轮扫描前按节流抓日历并 upsert；审计时计算 smart 触达
src/scan/refresh.ts         calendar 条目的链上事实补齐（沿用现有 needsRefresh）
src/scan/quality.ts         批量合约痕迹 → instant-sellout；smart 触达进 Q 分
src/scan/html.ts            面板：日历徽标/开售时间/地板/流动性标签/明细
src/audit/audit.ts          审计结果带 smartMinters 触达数
```

## A1 OpenSea 日历信息源

**解析契约（`calendar.ts`）**

- `parseCalendar(html)`：只读 `<script>` 中含 `urql_transport` 的片段，取 `.push(` 之后、去掉尾部 `);`，`JSON.parse`；深度遍历找 `dropCalendar.items`；**一个都没解析到 → throw**（页面格式变化或被拦截，绝不当"没有项目"）。
- `CalendarEntry`：`slug / name / chain / address / startTime / floorUsd / floorValue / floorSymbol / topOfferValue / volume24h / isVerified / disabledReason / stages[] / maxSupply / totalSupply`；只保留 slug 合法 + 链受支持的条目。
- `fetchCalendar({ fetchFn?, now? })`：GET `https://opensea.io/drops/upcoming`，固定浏览器 UA，跟随 307（fetch 默认），15s 超时；返回 `{ fetchedAt, entries }`。
- `calendarVerdict(previous, counts)`：金丝雀——某链上次 >0、这次为 0 → `{ warn: "chain-empty", chain }`；总量骤降 >80% → `warn: "volume-drop"`。

**状态与接入**

- `ContractEntry` 增加 `sources: string[]`、`calendar: CalendarFacts | null`：
  `CalendarFacts = { listedAt, startTime, floorUsd, floorValue, floorSymbol, topOfferValue, volume24h, isVerified, disabledReason, maxSupply, totalSupply, stages: {stage,startTime,endTime,price,maxPerWallet,allowlistCount}[] }`。
- `ScanState` 增加 `calendar?: { fetchedAt, counts: Record<string, number> }`（供节流与金丝雀；旧文件缺字段可读）。
- `upsertCalendar(state, entries, at)`：已存在则只补齐 calendar 字段与 `sources`（不覆盖链上事实）；不存在则建条目（`firstSeenBlock/lastSeenBlock = 0`，`sources: ["opensea-calendar"]`，`slug/name` 来自页面）。
- `scanner.ts`：每轮开始先 `maybeCalendar()`——距上次成功抓取 `< CALENDAR_INTERVAL_MIN`（默认 15）则跳过；失败只记 errors 并沿用旧数据；成功后 upsert + 保存 + 金丝雀报警。
- `--refresh-targets` 无需改动：日历条目天然缺 `endTime/totalMinted/owner`，会被现有 `needsRefresh` 拾起并补齐链上事实。

**面板**

- 名称列徽标：`日历`（来自日历）、`未认证`（listed 但 `isVerified === false`）、`平台禁用`（`disabledReason`）——后两者直接进 `notes` 与 Q 分惩罚。
- `start` 取值顺序：链上 `publicStart` → 历史 → 日历 `startTime`；两者都有且相差 >60s → 明细标 **`日程不一致（项目方改期？）`**。
- 明细加：日历开售、地板（USD/币种）、24h 量、drop 类型、stages 拆分、收录时间。

## A3 + A4-lite 秒空强化与聪明铸造者

**批量合约痕迹（进审计）**

- 在 `mintScan` 已有数据上判定：`stage.txs` 很少但 `tokens` 很多（单笔多个 `SeaDropMint`）、`payer ≠ minter`、`tx.from` 为合约（`eth_getCode != 0x`，抽样 ≤5 笔）。
- 输出 `batchMintEvidence: { batchTxs, clonedWallets, maxPerTxTokens }`；命中任一强条件 → Q 分惩罚 `batch-mint`（与 `instant-sellout` 并列，预设立场一致：默认排除）。

**聪明铸造者集合（`smart-minters.ts`）**

- `deriveSmartMinters(cacheEntries)`：对**售罄**目标，取其 `walletMints` 中 `minted ≥ capPerWallet`（吃满）或 `≥ 3` 的地址，累计出现次数；`appearances ≥ 2` 进入集合（按出现次数与涉及 drop 数排序）。
- 存储：`.smart-minters.json`（`{ version, updatedAt, minters: { addr: { appearances, drops: [] } } }`），由扫描器在审计后增量更新；审计读取它。
- 审计侧：`auditTarget` 接受可选 `smartSet`，用目标 `mintScan.walletMints` 求交集 → `AuditResult.smartMinters = { count, top?: string[] }`；写入历史与状态。
- Q 分：`participation` 维度加 `smartMinters` 子分（有值才计入，避免又一次"未知当 0"）；面板明细显示"聪明铸造者触达 N"。

## A2 保守估值护栏（`valuation.ts`）

- `conservativeValuation({ sales, floor, topOffer, now })`：照抄 mint-desk 规则并落成纯函数——24h 内 ≥3 笔**不同交易** + ≥2 个**不同买家** + 近 6h 有成交才 `supported`；每买家先取自身中位数再汇总（大买家不能主导）；`reference = min(floor, lowerQuartile × 0.8, topOffer)`；`floorDivergence = floor > lowerQuartile × 3`。
- 数据来源分层：日历地板/topOffer/24h 量（A1 已有）+ 回填的 `salesCount`/`floorUsd`（已有）+ 页面 `collectionActivity` 样本（有 slug 时按需抓，节流与日历共享）。
- 面板：`流动性` 标签（`有成交样本 / 样本不足 / 挂单偏离成交`）与"参考价"只对**已开售**行显示；**upcoming 不显示利润结论**（无二级成交，避免误导）。
- 创作者历史：新增"历史 drop 有真实成交"子信号（用回填 `salesCount ≥ 3`），进 `creatorScore`。

## 执行顺序与验证

1. **A1**：`tests/calendar.cjs`（解析、fail-loud、金丝雀、upsert 不覆盖链上事实）→ 实现 → 面板测试；真链验证：抓一次页面解析出的 robinhood 条数与**实测 3 条**一致。
2. **A3 + A4-lite**：`tests/smart-minters.cjs`（派生阈值、交集计数）→ 实现 → 审计/面板接线。
3. **A2**：`tests/valuation.cjs`（护栏四条件、买家等权、参考价公式、divergence）→ 实现 → 面板标签。
4. 每步：`npm run build && node --test tests/*.cjs` 全绿、离线结构验收、README/wiki/CHANGELOG 同步、方案包迁移。

## 关键取舍

- **链上仍是主源，日历是第二源**：日历条目单独标记 `sources`，不覆盖链上事实；链上事件到达后 `publicStart` 优先。
- **fail-loud 与金丝雀**：宁可报警也不要静默清空——这是上次 slug/筛选两次静默失效的教训。
- **聪明铸造者只做铸造侧**：Seaport 买卖与转账分类（mint-desk 完整版）留下一步；v1 只取售罄 drop 的铸造地址，噪声最低。
- **A2 只对已开售行给结论**：upcoming 无成交证据，不能编造利润——与 mint-desk 的克制一致。
