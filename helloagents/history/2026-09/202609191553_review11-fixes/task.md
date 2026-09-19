# 任务清单: review11 修复（M5b 运营与评分边界）

目录: `helloagents/plan/202609191553_review11-fixes_review11-fixes/`

review11 的四项"部署前必须处理" + 两个廉价小项。

---

## 1. OpenSea 限速与 429
- [√] 1.1 `RateLimiter`（令牌桶，`OPENSEA_RPS` 默认 2）与 `limitedFetch`（429 读 `retry-after` 退避重试一次，其余非 2xx 计 `rateLimited`），所有调用共用一个 limiter
- [√] 1.2 所有请求加超时（OpenSea 15s，X 10s），`RefreshSummary.rateLimited` 并在命令结尾提示

## 2. 状态文件并发写
- [√] 2.1 `state.ts` 新增 `saveStateMerged(patch)`：先读回文件、按合约字段合并，只写本次刷新的字段
- [√] 2.2 `refresh.ts` 改为按合约收集 patch 后合并写；`--serve` 调度器每轮跑有界刷新（`REFRESH_PER_TICK`，默认 20，0 关闭）

## 3. 创作者评分自我包含
- [√] 3.1 `creatorStatsFor(owner, facts, …, exclude)`：评分时排除目标自身；`dropCount === 0` → 创作者维度 `null`
- [√] 3.2 `html.ts` 用 `creatorStatsFor` 替换整表聚合，保留 `aggregateCreators` 为批量 API

## 4. 秒空标签
- [√] 4.1 `presaleShare` 从审计缓存的预售阶段铸出量计算；`demandScore` 在无速度时用预售占比回退
- [√] 4.2 `instant-sellout` 惩罚（免费 + 预售 ≥40% + 地址 ≥1000 + 每钱包 ≥5）：名称列红色徽标、`data-instant`、筛选「排除预计秒空」、预设默认勾选

## 5. 测试与文档
- [√] 5.1 `tests/refresh.cjs`：限速间隔、429 重试/放弃、合并写保留并发字段
- [√] 5.2 `tests/quality.cjs`：自排除、单 drop → null、秒空四条件、预售需求回退
- [√] 5.3 `tests/dashboard.cjs`：创作者自排除、秒空徽标与筛选/预设
- [√] 5.4 `npm run build` + `node --test tests/*.cjs`（105/105）
- [√] 5.5 README、`.env.example`/`.env.serve.example`、wiki/data.md、wiki/modules/scan.md、CHANGELOG

---

## 执行总结

**结果:** 13/13 完成。`npm run build` 通过、`node --test tests/*.cjs` **105/105**（新增 refresh 3 例 + quality 4 例 + dashboard 2 例）。

**离线结构验收：** 修正后的渲染 13 项检查全过；创作者自排除在"目标视角"与"同 creator 的另一个 drop 视角"两侧都验证（目标自己不算、别人的自有数据仍在）。

**审查意见采纳情况：** 四项全部确认属实并修复。小项采纳两条（超时；需求维度预售回退），未采纳一条——`aggregateCreators` 保留为批量 API，`html.ts` 改用带排除的 `creatorStatsFor`，pipeline 无死代码；`participationScore` 的 50 地址门槛按 review 建议"先观察两周再调"，本轮不动。
