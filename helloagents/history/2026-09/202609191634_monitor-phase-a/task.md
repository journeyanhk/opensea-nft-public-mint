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
- [√] 3.1 `src/scan/valuation.ts`：`conservativeValuation`（≥3 交易 + ≥2 买家 + 6h 新鲜；买家等权中位数；`reference = min(floor, lowerQuartile×0.8, topOffer)`；`floorDivergence`）
- [√] 3.2 面板：`流动性` 标签与参考价**只对已开售行**；upcoming 不给利润结论
- [√] 3.3 创作者历史：`历史 drop 有真实成交`（回填 `salesCount ≥ 3`）进 `creatorScore`
- [√] 3.4 `tests/valuation.cjs` + 面板断言

## 4. 收尾
- [√] 4.1 `npm run build` + `node --test tests/*.cjs` 全绿；离线结构验收
- [√] 4.2 README（日历源、`CALENDAR_INTERVAL_MIN`、流动性标签口径）、wiki/data.md（新字段）、wiki/modules/scan.md、CHANGELOG
- [√] 4.3 方案包迁移 history/2026-09/ + 更新 history/index.md + 提交推送

---

## 执行总结

**结果:** 13/13 完成（A1 5 + A3/A4-lite 5 + A2 4，其中 4.3 收尾并入本次）。`npm run build` 通过、`node --test tests/*.cjs` **125/125**。

**真链验证（A1）：** 真抓 `opensea.io/drops/upcoming`（1.9s）解析出 7 条：robinhood 3 / ethereum 3 / base 1，含 slug、合约、开售时间、地板（USDG/ETH）、认证、供应与 stages；Arc 确认不在日历（仍以链上事件为主源）。

**取舍与说明：**
- 解析器按实测修正为 `urql_transport`（该页 `__NEXT_DATA__` 出现 0 次），固定浏览器 UA 并跟随 307；解析不到一律 throw，某链由有变 0 或总量骤降打金丝雀告警，失败沿用旧快照。
- A4-lite 采用自动派生（售罄 drop 的吃满/重复铸造地址，≥2 次合格），无需人工名单；第一版只做铸造侧，Seaport 买卖与转账分类留待后续。
- 批量痕迹用 `maxTxTokens`（按 transactionHash 归组，单笔 ≥10 个即命中）+ `payerDiffers`；原设计中的"caller 为合约抽样"未做——需要 events 扫描保留样本 tx hash 再补 RPC，已记录为后续项。
- A2 的逐笔 Sale 样本（页面 collectionActivity）未做：当前用回填汇总证据给出流动性标签，`conservativeValuation` 纯函数已按护栏实现并测好，接入真实样本即可产出参考价。

## review12 修复（部署前，同日）

- [√] `refreshCalendar` 只保留 `opts.chains` 里的链；金丝雀基线同样按配置链过滤（原实现会把 Ethereum/Base 条目写进状态，永远 unaudited 并浪费 OpenSea 配额）
- [√] 日历新建条目 `pendingAudit=true`——原状态下它既不在日志窗口也没有 `publicStart`，不在任何候选种子列表里，**永远不会被审计**（比 review 描述更严重）
- [√] 新增 `calendar.publicStartTime`（最后阶段＝公售猜测）：面板开售回退与 `schedule mismatch` 只与它比较，最早阶段只是预售波次；明细标注「最早为预售阶段」
- [√] `state.calendar.warnings` 持久化 + `/api/status.calendar` 暴露（日历失败/金丝雀告警可见）
- [√] 真链验证：`chains: ["robinhood"]` 抓取后状态只有 robinhood（3 条、全部 `pendingAudit=true`），`publicStartTime` 与首阶段相差数天（证明对比基准修正的必要）；测试 126/126

**未做（如实记录）：** 无地址条目的 `calendarPending` 暂存（OpenSea 可能对未部署合约返回空地址）；逐笔 Sale 样本采集；caller-为合约的抽样判定。
