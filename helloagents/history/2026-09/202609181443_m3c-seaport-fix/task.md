# 任务清单: review8 修复（Seaport 1.6 成交地板价 + 币种/精度修正）

目录: `helloagents/plan/202609181443_m3c-seaport-fix/`

---

## 1. 事实纠正与数据源
- [√] 1.1 复核 review8：确认 Seaport 1.6 的 `OrderFulfilled` consideration 为 **5 字段**（多 `recipient`），topic0 = `0x9d9af8e3…f31`；旧 4 字段签名恒为 0 条，此前"链上无二级市场"的结论由该错误导致
- [√] 1.2 新增 `src/scan/seaport.ts`：正确 ABI 解码（offer ≥2 为 NFT、consideration ≤1 为付款、分币种求和）、`aggregateSales`（最近 N 笔、主导币种、最低/中位价、独立买家）、`scanSeaportSales`（复用窗口扫描 + 重试；**失败抛出而非静默为空**）
- [√] 1.3 真链复核（Robinhood）：HoodMiners 24h **46 笔**（low 0.003502 ETH / median 0.005049，15 买家）、Stock Salesman **25 笔**；Catonchain 24h 无成交（该收藏成交量本身极低，其计价为 USDG 6 位）

## 2. 币种与净值
- [√] 2.1 `parseStats(json, decimals)` 按币种精度用 `parseUnits` 解析（USDG 6 位不再被当成 18 位）
- [√] 2.2 新增 `parsePricing` / `usdPriceFor`：从 `collections/{slug}`（无 key）取 `decimals`/`usd_price`/`eth_price`，ETH/USD 由任一侧推导（USDG 的 0.999874/0.0004027 ≈ 2483）
- [√] 2.3 ERC-20 精度/符号走链上 `decimals()/symbol()`；成本换算 `costUsd`，地板换算 `floorUsd`，`netUsd` 仅在两边都能换算时计算（不再混币种相减）
- [√] 2.4 记录结构更新：`floorSource`（seaport/opensea）、`floorAtomic/Decimals/Symbol`、`floorUsd/costUsd/netUsd`、`lowAtomic/salesCount/uniqueBuyers`；看板净值列改显示 USD

## 3. 测试
- [√] 3.1 新增真实 fixture `tests/fixtures/orderfulfilled-v16.json`（Robinhood 链上抓取：Catonchain #390 以 0.73 USDG 成交），断言解码字段
- [√] 3.2 `tests/backfill.cjs` 更新/新增：聚合（多币种窗口）、精度解析（6 vs 18）、pricing 推导与 token 映射、Seaport 优先与 stats 回退、扫描失败显式报错、USD 净值
- [√] 3.3 `npm run build` 与 `node --test tests/*.cjs` 通过（**66/66**）

## 4. 文档
- [√] 4.1 纠正 `wiki/modules/feedback.md`（数据源与币种规则）、`wiki/data.md`（记录字段）、`README.md`（回填说明）、`CHANGELOG.md`
- [√] 4.2 代码头注释同步（`seaport.ts` / `backfill.ts` 说明 5 字段与币种约束）

---

## 执行总结

**结论：review8 成立，且是重要纠错。** 根因是 Seaport 1.6 的 `ReceivedItem` 多了 `recipient` 字段：`OrderFulfilled(bytes32,address,address,address,(uint8,address,uint256,uint256)[],(uint8,address,uint256,uint256,address)[])`，此前用旧签名扫描必然为 0，进而得出错误的"无二级市场"结论。修复后：

| 目标 | 24h 链上成交 | 最低成交价 | 独立买家 |
|---|---:|---:|---:|
| HoodMiners | 46 | 0.003502 ETH | 15 |
| Stock Salesman | 25 | 0.0001 ETH | 4 |

**币种问题同样成立**：Catonchain 的 `pricing_currencies` 为 USDG（decimals 6，usd_price 0.999874，eth_price 0.0004027），此前 `parseEther` 会按 18 位解析且净值用 USDG 减 ETH。现在按链上 `decimals()` 解析、统一换算 USD，无法换算时 `netUsd = null`。

**未验证（环境限制）：** `collections/{slug}` 与 `collections/{slug}/stats` 在本机需经代理，生产代码走直连；pricing/USD 路径由单测覆盖（含真实响应结构），请在你的环境跑一次 `--backfill` 复核。Arc 最近区块暂无 `OrderFulfilled`（该链二级市场不活跃），Seaport 地板价会自然回退到 stats。

---

## 任务状态符号
- `[ ]` 待执行
- `[√]` 已完成
- `[X]` 执行失败
- `[-]` 已跳过
- `[?]` 待确认
