# 数据模型

## 概述
无持久化数据库；状态来自 .env 环境变量与链上/API 返回。核心数据形状如下。

---

## 环境变量（.env）

| 字段名 | 类型 | 说明 |
|--------|------|------|
| PRIVATE_KEY / PRIVATE_KEYS | string | 明文私钥（可逗号/空白分隔多个） |
| RPC_URL_<CHAIN> / RPC_URL / EXTRA_RPC_URLS | string | 发送用 RPC（私有优先），逗号分隔 |
| SCAN_RPC_URL_<CHAIN> | string | 扫描/审计用 RPC（公共优先）；配置后优先使用，需支持宽 eth_getLogs 范围 |
| CHAIN | string | 默认链：ethereum/base/robinhood |
| MAX_FEE_PER_GAS | number(gwei) | 留空按链默认：ethereum 80、base/robinhood 2、arc 40 |
| MAX_PRIORITY_FEE | number(gwei) | 留空按链默认：ethereum 5、base/robinhood 0.05、arc 0 |
| GAS_LIMIT | number | 默认 250000 |
| OPENSEA_API_KEY | string | slug 解析用（可选） |

## 链上 Drop 参数（PublicDrop）

| 字段 | 类型 | 说明 |
|------|------|------|
| mintPrice | bigint | 单价（wei） |
| startTime / endTime | number | 开售/结束时间戳 |
| maxTotalMintableByWallet | number | 单钱包上限 |
| feeBps | number | 费率基点 |
| restrictFeeRecipients | boolean | 是否限制费用接收方 |

## OpenSea Drop 排期（stages）

| 字段 | 类型 | 说明 |
|------|------|------|
| start_time / end_time | string | ISO 时间 |
| label | string | 阶段名 |
| stage_type | string | public_sale / signed_presale 等 |

## 交易结构（校验通过后）

```json
{
  "to": "SeaDrop 单例地址",
  "data": "0x…mintSigned/mintAllowList/mintPublic calldata",
  "value": "wei 数量",
  "method": "mintPublic | mintSigned | mintAllowList",
  "stage": "阶段索引字符串"
}
```

## 批量配置（targets.json）

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| chain | string | 是 | 整批固定单链：ethereum/base/robinhood |
| walletSource | string | 否 | env（默认，走 .env）或 prompt（隐藏输入） |
| refreshBeforeMs | number | 否 | T-refresh 提前量，默认 3000 |
| auditBeforeMs | number | 否 | 开售前多久做链上复检，默认 1800000；0 关闭 |
| auditSkipGrades | string[] | 否 | 复检命中即跳过的等级，默认 `["C"]`；空数组表示从不跳过 |
| onFailure | string | 否 | continue（默认）或 stop |
| rpcs | string[] | 否 | 覆盖 .env 的 RPC 列表 |
| gas | object | 否 | `{ maxFeeGwei, priorityGwei, gasLimit }`，覆盖 .env |
| targets | object[] | 是 | `{ slug, quantity?, maxPriceEth?, startAt? }`；slug 支持链接/slug/合约地址；startAt 为 `"auto"` 或 ISO |

## 执行结果（SnipeResult）

| 字段 | 类型 | 说明 |
|------|------|------|
| idx | number | 钱包序号 |
| address | string | 钱包地址 |
| txHash | string \| null | 被 RPC 接受时为交易哈希，其余为 null |
| status | string | SUCCESS / REVERTED / TIMEOUT / REJECTED / SKIPPED |

## 链上供应量（NFT 合约 getMintStats）

| 字段 | 类型 | 说明 |
|------|------|------|
| mintedByWallet | bigint | 该钱包累计已铸（含白名单阶段，销毁不回退） |
| totalMinted | bigint | 全集合累计已铸（含已销毁，即供应量检查所用值） |
| maxSupply | bigint | 硬顶；0 表示合约未固定供应量，无法判定售罄 |

> `getMintStats` 在 NFT 合约上，SeaDrop 单例调用会 revert。`BatchTarget.supply` 仅存 `{ totalMinted, maxSupply }`。

## 执行账本（.batch-state.json，gitignore）

| 字段 | 类型 | 说明 |
|------|------|------|
| entries[chain][contract].status | string | PENDING / SUCCESS / REVERTED / TIMEOUT / REJECTED / SKIPPED |
| entries[chain][contract].txHash | string \| null | 非空即代表已广播，重启后不再重发 |
| entries[chain][contract].at | string | ISO 时间 |
| entries[chain][contract].quantity | number | 每钱包数量 |
| entries[chain][contract].slug | string \| null | 配置原始输入（供 M3c 回填复用） |
| entries[chain][contract].attempts | number | 发送尝试次数（REVERTED 在公售开放期最多重试 2 次） |

## 回填记录（.backfill.jsonl，gitignore）

| 字段 | 类型 | 说明 |
|------|------|------|
| checkpointHours | number | 24 / 72（可按 `--backfill-after` 自定义） |
| mintAt / at | string | mint 时间 / 回填时间（ISO） |
| mintValueWei / gasCostWei / costWei | string \| null | 交易 value、燃气费、合计成本（wei） |
| floorSource | string \| null | seaport（链上成交）或 opensea（stats） |
| floorAtomic / floorDecimals / floorSymbol | string \| null / number \| null / string \| null | 地板价原子单位、币种精度与符号（USDG 为 6） |
| floorUsd / costUsd / netUsd | number \| null | 换算成 USD 的地板价、成本与净值（仅两边币种均可换算时计算） |
| lowAtomic / salesCount / uniqueBuyers | string \| null / number \| null | 近 24h 链上最低成交价、笔数与独立买家数 |
| txHash | string \| null | 对应 mint 交易 |

## 审计历史记录（.scan-history.jsonl）字段

| 字段 | 说明 |
|------|------|
| at / chain / contract / grade / risks / reason / coverage | 审计时间、目标、等级、风险标签与原因、扫描覆盖率 |
| remaining / projected / start | 当前剩余、预计余量、公售开始时间 |
| name / owner / slug | 代币名称、owner()（失败为 null）与 OpenSea slug（已知时用于 `/collection/<slug>` 链接） |
| mintPriceWei / capPerWallet / endTime | 单价（0=FREE）、每钱包上限（0=不限）、结束时间 |
| maxSupply / totalMinted | 供应上限与审计当刻累计铸造（构成速度差分序列） |
| recent15m / recent1h | 日志分桶的 15 分钟与 1 小时铸造量 |
| uniqueMinters / topMinterShare / stageCount / presaleStages | 独立铸造地址、最大地址占比、阶段数与预售阶段数（stage != 0） |

> 24h 速度由相邻历史点的差分计算（不足 6 小时回退 1h×24 并在面板标注 bucket）；开售 72h 内的目标每 30 分钟复审以维持序列。

## 发现器状态（.scan-state.json / .scan-history.jsonl，均 gitignore）

| 字段 | 类型 | 说明 |
|------|------|------|
| chains[chain].cursorBlock | number | 已确认扫描到的区块（= latest − 64） |
| chains[chain].blockTimeSec | number | 扫描时实测的平均出块时间 |
| contracts[chain][addr].firstSeenBlock / lastSeenBlock | number | 首次/最近一次出现事件的区块 |
| contracts[chain][addr].lastAuditedBlock / lastAuditedAt | number \| null / string \| null | 最近一次审计的位置与时间 |
| contracts[chain][addr].lastGrade | string \| null | 最近审计等级 |
| contracts[chain][addr].soldOutAtBlock | number \| null | 判定售罄时的 `lastSeenBlock`（此后无新事件则不再重查） |
| contracts[chain][addr].publicStart | number \| null | 最近一次读到的公售开始时间（unix 秒） |
| contracts[chain][addr].pendingAudit | boolean | 曾是候选但超出 `--limit`，下次运行优先审计 |
| contracts[chain][addr].lastMintedTotal / quietStreak | string \| null / number | 上次审计的累计铸造量与连续「无新增」次数；≥2 时复审间隔放宽到 2 小时 |
| contracts[chain][addr].slug / name | string \| null | OpenSea slug 与代币名称；slug 一经解析永久缓存（`--refresh-targets` 补齐） |
| contracts[chain][addr].endTime / maxSupply / totalMinted | number \| null / string \| null | 公售结束时间、供应上限、最近一次读到的累计铸造（面板 phase 判定用） |
| contracts[chain][addr].owner | string \| null | `owner()`（`--refresh-targets` / 审计写入）；M5b 按它聚合创作者历史 |
| contracts[chain][addr].imageUrl / twitter / discord / website / createdDate / safelist | string \| null | `collections/<slug>`（**无需 key**）读取的合集身份字段；`--refresh-targets` 补齐 |
| contracts[chain][addr].socialCheckedAt | string \| null | collections 已读时间；即使合集没有社交链接也会写入，避免反复请求（404 视为已读，限流/网络失败不写、下次重试） |
| contracts[chain][addr].sources | string[] | 条目的发现来源：`onchain` / `opensea-calendar`（可并存） |
| contracts[chain][addr].calendar | object \| null | OpenSea 日历事实：`listedAt/startTime/endTime/floorUsd/floorValue/floorSymbol/topOfferValue/volume24h*/isVerified/disabledReason/maxSupply/totalSupply/stages[]`；只补齐、不覆盖链上事实（链上开售时间优先，相差 >1 分钟标 `schedule mismatch`） |
| ScanState.calendar | object \| undefined | `{ fetchedAt, counts }`：上次成功抓取时间（节流）与各链条目数（金丝雀基线） |
| contracts[chain][addr].xFollowers / xCheckedAt | number \| null / string \| null | X 粉丝数与读取时间；仅 `ENABLE_X_METRICS=1` 时抓取（`api.fxtwitter.com/<handle>`），24 小时缓存，失败静默 |

M5b 的派生字段（不落盘，`loadDashboardRows` 计算）：`social`（已知但为空 ≠ 未知）、`creator`（按 owner 聚合的 drop 数/售罄率/平均 24h 速度/二级成交/自有净值与 `ownData` 标记；**评分时排除目标自身**，`dropCount=0` 表示没有其它 drop → 创作者维度视为未知）、`presaleShare`（预售阶段铸出量 / 上限，来自审计缓存；用于需求代理与秒空判定）、`quality`（0–100 分 + `confidence` 覆盖率 + 维度拆分 + 惩罚项，见 `src/scan/quality.ts`）。缩略图仅在域名属于 `seadn.io` / `opensea.io` 且为 https 时才进 `src`；社交链接仅允许 http(s)。
并发写入：刷新用 `saveStateMerged(patch)` 做**字段级合并**（只写本次刷新的字段，先读回文件再合并），因此与正在运行的 `--serve` 扫描（整文件 `saveState`）不会互相抹掉合约或游标。

`scan-history.jsonl` 每行：`{ at, chain, contract, grade, remaining, projected, start }`。