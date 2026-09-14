# 数据模型

## 概述
无持久化数据库；状态来自 .env 环境变量与链上/API 返回。核心数据形状如下。

---

## 环境变量（.env）

| 字段名 | 类型 | 说明 |
|--------|------|------|
| PRIVATE_KEY / PRIVATE_KEYS | string | 明文私钥（可逗号/空白分隔多个） |
| RPC_URL_<CHAIN> / RPC_URL / EXTRA_RPC_URLS | string | RPC URL，逗号分隔 |
| CHAIN | string | 默认链：ethereum/base/robinhood |
| MAX_FEE_PER_GAS | number(gwei) | 默认 2，ethereum 链默认 80 |
| MAX_PRIORITY_FEE | number(gwei) | 默认 0.05，ethereum 链默认 5 |
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