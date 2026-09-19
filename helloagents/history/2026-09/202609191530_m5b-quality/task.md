# 任务清单: M5b 社交、创作者历史与 Q 分

目录: `helloagents/plan/202609191930_m5b-quality/`

M5a 已解决"能不能铸到"；M5b 回答"值不值得"，并把社交与创作者信号落到面板。

---

## 1. 数据层：社交与创作者信号
- [√] 1.1 `ContractEntry` 增加 `owner/imageUrl/twitter/discord/website/createdDate/safelist/xFollowers/xCheckedAt`
- [√] 1.2 `audit.ts` 的 `Social` 从布尔改为携带原值（handles/urls/image），审计把 owner 与社交写入状态
- [√] 1.3 `--refresh-targets` 扩展：读 `owner()`；已知/新解析 slug 时拉 `collections/{slug}`（无 key）填社交/缩略图/创建日期/safelist；`needsRefresh` 覆盖新字段
- [√] 1.4 X 粉丝数 opt-in（`ENABLE_X_METRICS=1`）：`api.fxtwitter.com/<handle>`，24 小时缓存到状态，失败静默

## 2. Q 分与创作者历史（纯函数）
- [√] 2.1 新增 `src/scan/quality.ts`：`aggregateCreators(rows, backfill, ledger)` 按 owner 聚合（drop 数、售罄率、平均 24h 速度、已知二级成交、自有 mint 与净值，标 ownData）
- [√] 2.2 `qualityScore(signals)`：需求 30 / 真实参与 20 / 创作者 20 / 社交身份 15 / 结构 15，未知维度按中性并降低 `confidence`；惩罚项（陈旧、集中度、开售前改价、无社交）独立输出

## 3. 面板
- [√] 3.1 名称列加**缩略图**（仅 https 且域名属于 seadn.io / opensea.io 白名单，`escapeHtml` 用于 src）与社交链接（x/discord/官网，仅 http(s)）
- [√] 3.2 新增「Q 分（置信度）」列与筛选（≥40/≥60/≥80）；预设升级为 **免费 · A/B · Q≥60 · 未开售/新开售**
- [√] 3.3 展开明细增加「创作者」区块：drop 数、售罄率、平均速度、二级成交、自有数据标注

## 4. 测试与文档
- [√] 4.1 `tests/quality.cjs`：创作者聚合、Q 分各维度与置信度、未知数据中性、惩罚项
- [√] 4.2 `tests/dashboard.cjs`：缩略图白名单（非 https/非白名单域名不渲染）、社交链接、Q 列与筛选、预设
- [√] 4.3 `npm run build` 与 `node --test tests/*.cjs`（当前 87 例不回归）
- [√] 4.4 更新 README（面板列与筛选、`ENABLE_X_METRICS`）、`wiki/data.md`（状态新字段）、`CHANGELOG.md`

---

## 执行总结

**结果:** 13/13 完成。`npm run build` 通过，`node --test tests/*.cjs` **97/97**（新增 `tests/quality.cjs` 8 例 + 面板相关 3 例）。

**离线真结构渲染验收（3 个合成目标，含社交/缩略图/创作者/净值）：** 14 表头 = 14 单元格、id 唯一、每个 `data-sort` 键都有行属性、Q 列与筛选/预设存在、白名单缩略图渲染而非白名单域名被丢弃、内联脚本语法有效、**0 外部资源**、行钩子完整（→ `/tmp/m5b.html`，21.9KB）。

**取舍与说明：**
- collections 端点无 key 也可读，因此社交/缩略图在无 key 的机器上也能补齐；slug 反查仍需 key（沿用 M5a.1 行为）。
- 未知维度不计分、只降置信度：宁可显示「Q 76 · 100%」或「—」，也不把没数据当合格。
- X 粉丝数为 opt-in 且只写状态（渲染保持同步、无网络），失败静默。
- 权重为经验初值，集中在 `quality.ts` 的 `WEIGHTS`，观察数据后可调。
