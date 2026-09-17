# 技术设计: 目标审计器 `--audit`（M1）+ 批量前置审计（M1.5）

## 核验附录（本方案的事实基础，均为 2026-09-17 实测）

### 数据源

| 数据源 | 结论 |
|---|---|
| `collections/{slug}`（无 key） | 可用，返回 name/contracts/chain/safelist_status/created_date/社交字段；但**会被限流**（连续请求后 401） |
| `drops/{slug}` | **必须 key**（无 key 401）；key 创建端点限流 `Maximum 2 keys per day` per IP |
| `getAllowListMerkleRoot` | 仅对 merkle 类型阶段有意义；`signed_presale` 合约（HoodMiners）调用 revert |
| `getSigners` / `getAllowedFeeRecipients` / `getPublicDrop` / `getMintStats` | 全部可用，Robinhood 与 Arc 行为一致 |
| `getMintStats.totalMinted` | 累计铸造（含已销毁），正是链上供应检查所用值；**不要用 API/ERC721 `totalSupply()`**（Exit Founders：3697 vs 4444） |

### 事件（关键发现）

`SeaDropMint` **由 SeaDrop 单例发出**，不需要逐个 token 扫描：

```
topic0 = keccak("SeaDropMint(address,address,address,address,uint256,uint256,uint256,uint256)")
       = 0xe90cf9cc0a552cf52ea6ff74ece0f1c8ae8cc9ad630d3181f55ac43ca076b7d6

indexed:  topic1 = nftContract, topic2 = minter, topic3 = feeRecipient
data[0..4] = payer, quantity, mintPrice, feeBps, dropStageIndex
```

实测：Arc 最近 5,000 块有 **3,499 条** `SeaDropMint`（41 个不同 drop）；Robinhood 上按 `topic1 = Stock Salesman` 过滤，4.6 天内 **2,112 条**，按 `dropStageIndex` 聚合得：

| Stock Salesman | 交易数 | 铸出 | 独立地址 | 单价 | 区块区间 |
|---|---:|---:|---:|---:|---|
| stage 1 | 1 | **111** | 1 | 0 | 63712043 |
| stage 2 | 1,478 | 1,478 | 1,478 | 0 | 63729137..63763786 |
| stage 3 | 633 | 633 | 633 | 0 | 63763798..63763821 |
| 合计 | 2,112 | **2,222** | 2,111 | | 最后铸造早于公售 1.3h |

> 外部方案里的"白名单容量 111 + 2,022 + 3,197"是误读：**111 是单个地址一笔铸出的数量**；5,330 个名额只有 2,111 个地址真正铸到。这是"用链上实测曲线代替名额公式"的直接依据。

### 扫描成本与窗口上限

| 链 | 出块 | `eth_getLogs` 窗口 | 实测 |
|---|---|---|---|
| Robinhood | **0.101 s/块**（~10 blocks/s） | 100k 块/次可用 | 40 窗口扫 ~4.6 天：2.7–3.4s（并发 40 时约 17% 窗口失败，需重试） |
| Arc | 0.51 s/块 | **5,000 块 OK，10,000 报 `requested range too large`** | 5,000 块（~42 分钟）内 3,499 条 mint |

`PublicDropUpdated` 语义变更实测：Stock Salesman 6 次事件中 3 次真的改了 `startTime`（07:00→16:00→18:00→18:30）；HoodMiners 4 次事件语义零变化 → **必须比对解码后的字段，不能数事件条数**。

## 技术方案

### 核心技术
- TypeScript 5.3 / Node 18+（不使用 `node:sqlite` 等新版本特性）；不引入新依赖（fetch + ethers 已有）
- 复用：`chains.ts`、`rpc-resolver.planRpcs`、`seadrop-public`、`nft-link.parseNftLink`、`slug-resolver`、`allowlist`、`prompt`、`time-format`

### 模块结构

```
src/audit/
  audit.ts   编排：auditTarget(input, opts) → AuditResult（结构化，CLI 与 batch 共用）
  events.ts  scanSeaDropMints / scanPublicDropUpdates / blockTime（窗口扫描 + 重试 + 缓存）
  score.ts   纯函数：headroomUpperBound / projectHeadroom / gradeTarget / explain
  report.ts  表格渲染 + targets.<chain>.json 导出（复用 loadBatchConfig 校验）
  cache.ts   .audit-cache/<chain>/<contract>.json（游标 + 快照，TTL 5 分钟）
```

### 数据流（单目标）

1. **链上**（rpcUrls[0]）：`buildLocalMintPlan`（能力判定）→ `getPublicDrop` → `getMintStats(0x0)` → 每个钱包 `getMintStats(wallet)` → `getSigners` / `getAllowedFeeRecipients` / `name()`。
2. **事件**（单例 + topic 过滤）：近 7 天 `PublicDropUpdated`（按 `topic1 = contract`）与 `SeaDropMint`；按 `dropStageIndex` 聚合出「各阶段 tx/铸出/独立地址/Top 集中度」；`SeaDropMint` 的时间轴用区块头时间戳（只对聚合后的少数边界区块取时间）。
3. **可选增强**（仅当 `.env` 有 `OPENSEA_API_KEY`）：`drops/{slug}` 的阶段名称/名额、`collections/{slug}` 社交与创建日期、逐钱包 `--check-allowlist` 资格。
4. **打分**（score.ts 纯函数）。
5. **输出**：表格行 + 等级 + 原因；`--export` 写配置并过 `loadBatchConfig`。

### 打分规则（可测试的纯函数）

```
requested      = quantity × 钱包数（无钱包信息时按 1 计）
remaining      = maxSupply − totalMinted            // maxSupply=0 → null（未知）
rate15         = 近 15 分钟 SeaDropMint 铸出数 / 15
rateConfident  = 样本 ≥ 10 分钟 且 ≥ 20 笔
minutesToOpen  = max(0, (startTime − now) / 60)
projected      = remaining − rate15 × minutesToOpen  // 公售已开始 → projected = remaining

等级（两个 headroom 各自给级 + 综合取较低者）:
  上界级: remaining ≥ requested → A | 0 < remaining < requested → B | remaining ≤ 0 → C | null → B(未知)
  实测级: projected ≥ requested → A | projected > 0 → B | projected ≤ 0 且 rateConfident → C | 否则 B
风险标签（不单独降级，展示为 ⚠）:
  lastMinutePriceChange / lastMinuteStartChange（开售前 60 分钟内）
  startChangeCount、topMinterShare ≥ 50%、无社交（有 API 时）
D 级（仅在有 API 时判定）: 无任何社交 且 created_date 距开售 < 24h
```

> 综合等级下限保护：没有 API key 时不会判 D；`rateConfident=false` 时不会因投影判 C。

### 配置导出

- 每个目标：`slug`（合约地址）、`quantity`（用户显式）、`maxPriceEth`（用户显式，免费填 `"0"`）、`startAt: "auto"`、可选 `auditBeforeMs`
- 按链分文件 `targets.<chain>.json`；导出后立即 `loadBatchConfig` 校验并打印 BATCH SCHEDULE 预览；不合法目标剔除并逐条说明

### M1.5 批量前置审计

- `targets.json` 新增：`auditBeforeMs`（默认 `1800000`，`0` 关闭）、`auditSkipGrades`（默认 `["C"]`）
- 接入点在 `batch-runner` 的逐目标循环内、调用 `localPublicSnipe` 之前：

```
if (cfg.auditBeforeMs > 0) {
  const deadline = t.startAt.getTime() - cfg.auditBeforeMs;
  if (deadline > Date.now()) await waitForMintTime(new Date(deadline), 0);
  else console.log("审计已过点，立即执行");
  const audit = await auditTarget(...).catch(err => { warn; return null; });   // fail-open
  if (audit && cfg.auditSkipGrades.includes(audit.grade)) { 记 SKIPPED; continue; }
}
```

- 不改 `local-mint`；T-3s 的 `getMintStats` 检查保持不变，作为最后一道兜底

## 架构决策 ADR

### ADR-8: 审计（M1）优先于发现（M2）
**上下文:** 外部方案主张 scanner → enricher → scorer；用户三次失败都发生在已知目标上。
**决策:** 先做 `--audit` 与导出，`--scan` 发现器后置。
**理由:** 止血点在"已选目标值不值得排"，审计不依赖任何新采集设施即可交付。
**替代方案:** 发现器先行 → 拒绝原因: 新目标发现不能阻止已知目标的亏损，且 Arc/Robinhood 每天新 drop 数百，人工筛选成本高于收益。
**影响:** 短期内仍需人工提供目标列表（链接/地址/文件）。

### ADR-9: 链上为主判据，OpenSea 为可选增强
**上下文:** `drops` 需 key（每 IP 每天 2 个、会过期），`collections` 无 key 但会限流。
**决策:** 等级判定只依赖链上数据；API 信息仅作展示与 D 级判定。
**理由:** 审计必须在 key 失效时仍可用；实测无 key 时全部核心判据可得。
**替代方案:** 以 API 为主 → 拒绝原因: 关键路径不可用时会瞎。
**影响:** 缺少"你这几个钱包是否在白名单"的自动结论（该功能需 API，标为可选）。

### ADR-10: headroom 用实测铸造曲线，不用名额公式
**上下文:** `allowlist_wallet_count × max_per_wallet` 是上界且跨阶段重复计数；Stock Salesman 5,330 名额 vs 实际 2,111 地址。
**决策:** 主判据 = `maxSupply − totalMinted`（上界）与 `剩余 − 近期速率 × 距开售时间`（实测投影）；两数各给等级。
**理由:** 成本更低、无需 key、且直接对应"公售有没有货"。
**替代方案:** 名额公式 → 拒绝原因: 实测偏差 2.5 倍以上，会把有货目标误杀。
**影响:** 需要在审计时扫描 7 天事件（有缓存与窗口上限约束）。

### ADR-11: 不引入原生依赖存储
**上下文:** `better-sqlite3` 需要编译，破坏 Windows 一键安装与零依赖特性。
**决策:** 用 `.audit-cache/<chain>/<contract>.json` + JSONL 快照；`--scan`（M2）同样使用 JSON 游标与快照。
**理由:** 数据量级小（每天数百 drop、单文件 <100KB），JSON 足够；无运维负担。
**替代方案:** `node:sqlite` → 拒绝原因: 需要 Node 22+，与项目声明的 Node 18+ 不符。
**影响:** 无 SQL 查询能力；M3 看板若需要复杂查询再评估。

### ADR-12: M1.5 接入 batch-runner（不改 local-mint），fail-open
**上下文:** 需要在开售前用审计结果拦截"没货"的目标，同时不能让审计故障阻断 mint。
**决策:** 在 `batch-runner` 逐目标循环中、调用执行器前做前置审计；审计失败只告警；`auditSkipGrades` 可配置。
**理由:** 保持执行器单一职责（签名/广播），职责边界清晰；审计故障时退化为现有行为。
**替代方案:** 塞进 `local-mint` 的重读循环 → 拒绝原因: 执行模块依赖审计模块，耦合变差且影响向导路径。
**影响:** 审计与 T-3s 之间仍有时间窗（由 T-3s 的 `getMintStats` 兜底）。

## API设计

### `auditTarget(input, opts): Promise<AuditResult>`
- **请求:** `{ chain, contractOrSlug, wallets?, requestedQuantity?, lookbackDays=7, useApi? }`
- **响应:** `{ chain, contract, name, publicStart, price, capPerWallet, remaining, upperGrade, projected, projectedGrade, grade, riskFlags[], reasons[], stageMints[], changeHistory[], social? }`

### `scanSeaDropMints(chainKey, contract, opts)` / `scanPublicDropUpdates(chainKey, contract, opts)`
- 返回聚合结果；内部按链窗口上限分片，串行 3 并发 + 指数退避（最多 4 次），读写 `.audit-cache`

### CLI
- `npm start -- --audit <target...> [--wallets 0x..,0x..] [--lookback-days 7] [--export <path>] [--grade A,B] [--json]`

## 数据模型

```jsonc
// .audit-cache/<chain>/<contract>.json
{
  "scannedToBlock": 65140000,
  "scannedAt": "2026-09-17T06:40:00Z",
  "publicDropUpdates": [ { "block": 63608056, "price": "10000000000000000", "startTime": 1757951400, "cap": 3 } ],
  "stageMints": { "1": { "txs": 1, "tokens": "111", "minters": ["0x.."], "firstBlock": 63712043, "lastBlock": 63712043 } }
}

// targets.json 新增字段
{ "auditBeforeMs": 1800000, "auditSkipGrades": ["C"] }
```

## 安全与性能

- **安全:** 全部为只读调用；不写私钥；`OPENSEA_API_KEY` 只从 `.env` 读、不落盘不打印；缓存目录加入 `.gitignore`；导出的 `targets.*.json` 不含任何密钥。
- **性能:** 窗口上限（Robinhood 100k / Arc 5k）；串行 3 并发 + 重试；7 天回溯 + 增量游标；单目标典型 <5 秒（Robinhood）/ <15 秒（Arc 含限流退避）。

## 测试与部署

- **单元测试（`tests/audit.cjs`）:** `headroomUpperBound`、`projectHeadroom`、`gradeTarget`（A/B/C/D、无 key 下限、rateConfident 保护）、`SeaDropMint` 解码（用真实 log fixture）、窗口分片与重试决策（注入假 RPC）。
- **验收（真链，只读）:**
  - Stock Salesman（`0xd7ab9a35…2599`）→ C，证据含 "2222/2222，最后铸造早于公售 1.3h"
  - HoodMiners（`0x3D56Ab8…13B4`）→ 售罄后 C；事件史 4 次但无语义变更
  - Exit Founders（`0x1f7dB502…1573`）→ C，证据用 `getMintStats`（4444）而非 `totalSupply()`（3697）
  - Catonchain → A/B 且带"开售前改价"⚠（其合约地址待用户提供，或用 `--scan` 阶段补齐）
- **回归:** `npm run build` + `node --test tests/*.cjs`（现有 25 例不得回归）。
- **部署:** 无服务端；本地 CLI。M1.5 仅改变 `--batch` 行为，`auditBeforeMs: 0` 可完全回退。
- **不在本包范围:** M2 `--scan` 发现器与 JSON 游标、M3 看板与地板价回填。
