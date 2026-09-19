# 任务清单: 监控优先阶段 A

目录: `helloagents/plan/202609191634_monitor-phase-a/`

范围：A1（日历信息源）→ A3 + A4-lite（秒空强化 + 聪明铸造者）→ A2（保守估值）。mint 侧（B1–B4）另立方案。

---

## 1. A1 OpenSea 日历信息源
- [√] 1.1 `src/scan/calendar.ts`：`parseCalendar(html)`（`urql_transport` push → `dropCalendar.items`，**解析不到即 throw**）、`fetchCalendar`（固定 UA、跟随 307、15s 超时）、`calendarVerdict`（金丝雀：某链由有变 0 / 总量骤降）
- [√] 1.2 状态：`ContractEntry.sources/calendar`、`ScanState.calendar`；`upsertCalendar` 只补日历字段、不覆盖链上事实
- [√] 1.3 `scanner.ts`：按 `CALENDAR_INTERVAL_MIN`（默认 15）节流抓取，失败沿用旧数据并记 errors；成功 upsert + 金丝雀告警
- [√] 1.4 面板：`日历/未认证/平台禁用` 徽标、start 取值优先级、明细（地板/24h 量/stages/收录时间）、`日程不一致` 标记
- [√] 1.5 `tests/calendar.cjs`（真实结构 fixture + fail-loud + 金丝雀 + upsert 语义）；真链验证解析出的 robinhood 条数与实测一致

## 2. A3 + A4-lite 秒空强化与聪明铸造者
- [√] 2.1 `src/scan/smart-minters.ts`：`deriveSmartMinters`（售罄 drop + 吃满/≥3 + 出现 ≥2 次）、`.smart-minters.json` 读写
- [√] 2.2 审计：`AuditResult.smartMinters`（与目标 `walletMints` 交集），写入历史；扫描器审计后增量更新集合
- [√] 2.3 批量合约痕迹：`batchMintEvidence`（单笔多 mint、payer≠minter、caller 为合约抽样）→ Q 分惩罚 `batch-mint` + 面板徽标
- [√] 2.4 Q 分：`participation` 加 `smartMinters` 子分（有值才计入）
- [√] 2.5 `tests/smart-minters.cjs` + 面板断言

## 3. A2 保守估值护栏
- [ ] 3.1 `src/scan/valuation.ts`：`conservativeValuation`（≥3 交易 + ≥2 买家 + 6h 新鲜；买家等权中位数；`reference = min(floor, lowerQuartile×0.8, topOffer)`；`floorDivergence`）
- [ ] 3.2 面板：`流动性` 标签与参考价**只对已开售行**；upcoming 不给利润结论
- [ ] 3.3 创作者历史：`历史 drop 有真实成交`（回填 `salesCount ≥ 3`）进 `creatorScore`
- [ ] 3.4 `tests/valuation.cjs` + 面板断言

## 4. 收尾
- [ ] 4.1 `npm run build` + `node --test tests/*.cjs` 全绿；离线结构验收
- [ ] 4.2 README（日历源、`CALENDAR_INTERVAL_MIN`、流动性标签口径）、wiki/data.md（新字段）、wiki/modules/scan.md、CHANGELOG
- [ ] 4.3 方案包迁移 history/2026-09/ + 更新 history/index.md + 提交推送
