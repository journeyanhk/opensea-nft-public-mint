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

`scan-history.jsonl` 每行：`{ at, chain, contract, grade, remaining, projected, start }`。