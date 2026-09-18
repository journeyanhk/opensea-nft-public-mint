# feedback 模块

## 目的
mint 后反馈闭环：对账本中成功 mint 的目标，在 +24h / +72h 结算真实成本（链上）与地板价（OpenSea），把净值写入本地记录，供看板展示与后续评分校准。

## 模块概述
- **职责:** `dueCheckpoints` 到期选择（纯函数）；链上成本（`eth_getTransactionByHash` 的 value + 回执 `gasUsed × effectiveGasPrice`）；OpenSea `collections/{slug}/stats` 地板价/24h 量（有 key 时）；`.backfill.jsonl` 追加；幂等（按 chain+contract+checkpoint 去重）；`--backfill` CLI
- **状态:** ✅稳定
- **最后更新:** 2026-09-17

## 规范
### 需求: 地板价回填
**模块:** feedback
- 数据源：**Seaport 1.6 成交为主**（无需 key），OpenSea stats 为辅。注意 Seaport 1.6 的 `OrderFulfilled` consideration 是 **5 字段**（多了 `recipient`），topic0 = `0x9d9af8e3…f31`；用 1.1–1.5 的 4 字段签名会**永远匹配 0 条**（本模块曾因此误判"链上无二级市场"）。NFT 合约不在 topics 里（topic1=offerer），必须解码 offer 过滤
- 成交价按 consideration itemType 0/1（原生/ERC-20）**分币种求和**，取最近 N 笔（默认 50）中主导币种的最低/中位价；扫描失败**必须显式报错**，不得当作"无成交"
- 成本 = `tx.value + gasUsed × effectiveGasPrice`（从回执取；缺 `effectiveGasPrice` 时回退 `tx.gasPrice`）
- 币种与精度：成交币可能是原生币或 ERC-20（Robinhood 上实测 USDG 6 位、WETH 18 位）。ERC-20 的 `decimals()/symbol()` 走链上 `eth_call`；价格一律按各自 `decimals` 用 `parseUnits` 解析，**不假设 18 位**
- USD 换算：`collections/{slug}`（无 key）的 `pricing_currencies` 给出 `decimals`/`usd_price`/`eth_price`；ETH/USD 由任一侧推导（`usd_price / eth_price`，如 USDG 的 0.999874/0.0004027 ≈ 2483）。无 pricing（地址且无 key）时只记原子价与币种，`netUsd = null`
- 净值 = `floorUsd × quantity − costUsd`；**只有两边都换算成 USD 才计算**（USDG 地板价减 ETH 成本是无意义的）
- 记录字段：`{ at, chain, contract, slug, checkpointHours, mintAt, quantity, mintValueWei, gasCostWei, costWei, floorPriceWei, floorSymbol, volume24hWei, sales24h, netWei, txHash }`
- 净值 = `floorPriceWei × quantity − costWei`（两者都有才算）
- 幂等：同一 `(chain, contract, checkpointHours)` 已记录则跳过；成本与地板价都取不到时不写记录，下次重试
- 命令：`npm start -- --backfill [--ledger <file>] [--backfill-after 24,72] [--backfill-file <file>]`，适合挂在扫描循环末尾或每天 cron 一次
- 评分校准：累计 ≥20 个样本、约两周后，再用"等级/风险标签 → 24h 净值"的交叉表调整 `score.ts` 权重（当前不动）

## API接口
### 导出（`src/scan/backfill.ts`）
- `dueCheckpoints(ledger, existing, nowMs, horizonsHours)` → `DueItem[]`（纯函数）
- `computeCost(mintValueWei, gasUsed, effectiveGasPrice)` → bigint（纯函数）
- `parseStats(json)` → `StatsLike`（纯函数，兼容 `total` 与 `intervals`）
- `loadBackfill(file)` / `appendBackfill(records, file)`
- `runBackfill(ledger, opts)` → `{ due, written, withoutStats, errors }`；`opts.deps` 可注入网络实现（测试用）
- `runBackfillCommand(args)`（backfill-cli）

## 数据模型
```jsonc
// .backfill.jsonl（每行一条，gitignore）
{
  "at": "2026-09-17T12:00:00.000Z", "chain": "robinhood", "contract": "0x3d56…13b4",
  "slug": "0x3d56…13b4", "checkpointHours": 24, "mintAt": "2026-09-13T12:00:00.000Z",
  "quantity": 1, "mintValueWei": "0", "gasCostWei": "8826121200000", "costWei": "8826121200000",
  "floorPriceWei": null, "floorSymbol": "ETH", "volume24hWei": null, "sales24h": null,
  "netWei": null, "txHash": "0x9d2e…e826"
}
```

## 依赖
- batch-ledger（账本）、chains、rpc-resolver（`resolveScanRpcs`）、ethers；看板（`scan/html`）读取本模块记录

## 变更历史
- [202609171655_m3-pipeline](../../history/2026-09/202609171655_m3-pipeline/) - M3c：成本与地板价回填、看板净值列
