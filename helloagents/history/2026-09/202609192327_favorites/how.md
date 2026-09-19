# 怎么做: 收藏（方案 C）与筛选保持

## 数据模型（`.favorites.json`，gitignore）

```
{ version: 1, updatedAt, favorites: {
  "robinhood|0xabc…": {
    chain, contract, slug, name,        // 身份（板面消失后仍可读）
    addedAt, updatedAt,
    status: "watching" | "ready" | "dismissed",
    note: string,                        // 自由备注
    snapshot: { at, grade, q, confidence, phase, start, mintPriceWei,
                remaining, maxSupply, minted, velocity24h, uniqueMinters,
                topMinterShare, smartMinters, batchMint, penalties[],
                calendarListed, creatorDropCount }   // 收藏那一刻的信号
  } } }
```

- 纯函数 `src/scan/favorites.ts`：`favoriteKey`、`upsertFavorite`、`removeFavorite`、`toJsonl`、`loadFavorites`/`saveFavorites`（临时文件 + rename）
- 快照由面板在点击时从 `data-snapshot`（TS 侧序列化）取得，避免客户端复算

## 服务端（`--serve`）

- `GET /api/favorites`：返回 store；`?format=jsonl` 返回每行一条（含快照），带 `content-disposition`
- `POST /api/favorites`：`{ action: "add"|"update"|"remove", chain, contract, status?, note?, snapshot? }`
- 校验沿用 `/api/scan`：JSON content-type、Origin 同源；写入原子化

## 面板（`renderDashboard`）

- 名称列加星标按钮（`data-favorite`），点击切换：serve 模式 `POST` 乐观更新，失败回滚并提示；静态模式写 localStorage
- 顶部 tab：`全部 / 收藏 (N)`；收藏 tab 只显示收藏行 + "已不在板面"分区（来自 store 但不在 rows 里的条目）
- 收藏行的备注/标签在展开明细里可编辑（serve 模式保存；静态模式仅本浏览器）
- 导出按钮：复制 shortlist（已有）＋下载 `targets.json`（收藏集）＋下载收藏 JSONL
- 筛选保持：`grade/phase/chain/free/pending/executed/excludeInstant/q/search/sort/tab` 写入 `location.hash`；加载时 hash 优先，无 hash 用 localStorage；「复制筛选链接」

## 接线

- `cli.ts`/`index.ts`：`--report` 时读取 `.favorites.json` 传给渲染；新增 `--export-favorites <file>`（无服务端也能导出分析样本）
- `server.ts`：路由 + 守卫；`scheduler` 不需要改（收藏与扫描状态无关）

## 验证

1. `tests/favorites.cjs`：key 归一化、增删改、JSONL、原子写、快照缺失容忍
2. `tests/serve.cjs`：GET/POST 往返 + content-type/Origin 守卫 + jsonl
3. `tests/dashboard.cjs`：星标/`data-favorite`/tab/嵌入 store/筛选保持脚本存在、静态模式提示
4. 手工：浏览器点星 → 刷新 → 收藏仍在；换 tab → 筛选保留；`--export-favorites` 输出可读 JSONL
