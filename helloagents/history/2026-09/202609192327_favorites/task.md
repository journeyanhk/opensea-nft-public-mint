# 任务清单: 收藏（方案 C）与筛选保持

目录: `helloagents/plan/202609192327_favorites/`

---

## 1. 收藏数据层
- [√] 1.1 `src/scan/favorites.ts`：store 类型、`favoriteKey`/`upsertFavorite`/`removeFavorite`/`toJsonl`、原子 `saveFavorites`
- [√] 1.2 `tests/favorites.cjs`：增删改 + JSONL + 旧数据/缺字段容忍 + key 归一化

## 2. 服务端 API
- [√] 2.1 `GET /api/favorites`（含 `?format=jsonl` 与下载头）
- [√] 2.2 `POST /api/favorites`（add/update/remove；JSON + 同源守卫）
- [√] 2.3 `tests/serve.cjs` 往返与守卫用例

## 3. 面板
- [√] 3.1 名称列星标（`data-favorite`、乐观更新、失败回滚）
- [√] 3.2 tab「全部 / 收藏 (N)」+「已不在板面」分区
- [√] 3.3 收藏时写入信号快照（`data-snapshot`，TS 侧序列化）
- [√] 3.4 备注/标签编辑（明细内）；导出 shortlist / targets.json / JSONL
- [√] 3.5 筛选/排序/tab 持久化（hash 优先 + localStorage 兜底 + 复制筛选链接）
- [√] 3.6 `tests/dashboard.cjs` 断言（星标、tab、embed、快照、静态提示）

## 4. 接线与收尾
- [√] 4.1 `--report` 读取 `.favorites.json` 渲染；新增 `--export-favorites <file>`
- [√] 4.2 `.gitignore` + README + wiki（data/modules）+ CHANGELOG
- [√] 4.3 `npm run build` + 全量测试 + 离线结构验收；方案包迁移 + 推送

---

## 执行总结

**结果:** 14/14 完成。`npm run build` 通过、`node --test tests/*.cjs` **134/134**（新增 favorites 6 例 + serve 收藏 API 1 例 + 面板收藏面 1 例）。

**验证：** ① CLI 端到端：`--export-favorites` 输出的 JSONL 含 `key/status/note/snapshot`；② serve API 往返（add → update → jsonl → 页面内嵌 → remove）与守卫（text/plain 415、跨源 403）；③ 面板断言星标、快照随行、tab、已不在板面、导出按钮、hash 持久化脚本、静态提示。

**取舍：**
- 快照以**收藏那一刻**为准、不随后续审计刷新（这是"我当时看到了什么"的标注数据，覆盖会破坏分析价值）。
- 客户端脚本是字符串常量（`panel-client.ts`），静态页与 serve 共用；无外部资源、无模板字符串，避免在页面模板里嵌套转义。
- 收藏与执行结果的自动关联视图留到 B 阶段（等回执/账本字段落地）。
