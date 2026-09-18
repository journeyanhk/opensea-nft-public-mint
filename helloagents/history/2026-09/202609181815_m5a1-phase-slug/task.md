# 任务清单: review10 修复（slug 持久化 + phase 生命周期）

目录: `helloagents/plan/202609181815_m5a1-phase-slug/`

---

## 1. 链接：slug 持久化与可落地的链接
- [√] 1.1 `ContractEntry` 增加 `slug/name`；审计结束把 slug/name 写回状态（每个合约只解析一次）
- [√] 1.2 新增 `src/scan/refresh.ts` 与 `--refresh-targets [--limit N] [--chain] [--state]`：对缺字段的合约做轻量刷新（`buildLocalMintPlan` + `getMintStats` + 反查 slug + `name()`），幂等可重复执行
- [√] 1.3 面板链接：有 slug → `opensea.io/collection/<slug>`；无 slug → 不再兜底 item 页，只显示浏览器链接并标 `slug?`
- [√] 1.4 `/api/status` 增加 `openseaKey: set|unset`（排查 slug 为空的常见原因）

## 2. 已结束/长期开放项目：引入 phase
- [√] 2.1 `ContractEntry` 增加 `endTime/maxSupply/totalMinted`；候选过滤与审计顺手落盘（零额外请求）
- [√] 2.2 `src/scan/html.ts` 新增纯函数 `classifyPhase`：`upcoming` / `live-fresh`（开售 ≤24h）/ `live` / `stale` / `sold-out` / `ended` / `unaudited`（缺事实），数据源优先取合约状态、历史兜底
- [√] 2.3 面板：新增 phase 列与筛选，默认 `upcoming + live-fresh`；其余阶段隐藏并显示各阶段计数；开售超过一周且已结束的行不再渲染（状态保留）；`unaudited` 行等级显示 `?` 而不是旧等级
- [√] 2.4 预设按钮改为 `FREE · A/B · upcoming`（phase=focus）

## 3. 测试
- [√] 3.1 `classifyPhase` 全生命周期断言（含缺事实 → unaudited、sold-out 优先于 ended）
- [√] 3.2 已结束 >7 天不渲染、1 天内仍渲染并标 `ended`
- [√] 3.3 `needsRefresh` 记录判定；无 slug 时 `links.opensea` 为空且渲染 `slug?`；已知 slug 时链接为 `/collection/<slug>`
- [√] 3.4 `npm run build` 与 `node --test tests/*.cjs`（**86/86**）

## 4. 文档
- [√] 4.1 更新 `README.md`（默认 phase 视图、`--refresh-targets`、链接规则）、`wiki/data.md`（状态新字段）、`modules/scan.md`（refresh 需求）、`CHANGELOG.md`

---

## 执行总结

**结论：review10 成立，两个问题各占数据层与展示层一半。** 根因与证据：

| 现象 | 根因 |
|---|---|
| 链接是 item 页 | slug 只在审计时（且有 key）解析、且只写进历史；升级前的行没有 slug，展示层兜底成 `/assets/<chain>/<contract>/1`（OpenSea 会重定向到 `/item/...`） |
| 已结束项目仍显示 | 候选只排除"已结束/horizon 外"；行来自全部状态、不看 `endTime`；`staleVerdict` 对缺 `minted/maxSupply` 的旧行直接返回 false |

**真链验证（`--refresh-targets`）：**

```
summary: {"candidates":2,"processed":2,"factsUpdated":2,"remaining":0}
0xf0bcf2ee…（flamingos）end=2026-07-20 minted=5555/5555 → phase=sold-out
0xd7ab9a35…（stock-salesman）end=2026-09-16 minted=2222/2222 → phase=sold-out
```

默认视图（`upcoming + live-fresh`）下这些行不再出现，仅在计数里可见；运行一次 `--refresh-targets` 即可把历史遗留的 900+ 合约归类并补齐 slug（有 key 时）。

**后续（M5b 一并处理）：** 创作者历史与 Q 分将直接消费本次落盘的 `slug/name/owner/phase`；`live`/`stale` 的折叠视图与"开售冲突警告"放在 M5b/M5c。
