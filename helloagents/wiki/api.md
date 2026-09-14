# API 手册

## 概述
本项目对外部服务的调用点：OpenSea REST API（slug 解析与 Drops 签名交易）以及各链 RPC（eth_* JSON-RPC）。

## 认证方式
- OpenSea: `x-api-key` 头（`OPENSEA_API_KEY`）
- RPC: 无认证或 Alchemy key 内嵌于 URL

---

## 接口列表

### OpenSea REST

#### GET /api/v2/collections/{slug}
**描述:** slug → collection 信息（合约地址、链）

**请求参数:**
| 参数 | 说明 |
|------|------|
| x-api-key | 可选，无 key 时 401 概率高 |

**输出:** `name`、`contracts[].address`、`contracts[].chain`

#### GET /api/v2/drops/{slug}
**描述:** 获取 drop 排期与 chain/contract

#### POST /api/v2/drops/{slug}/mint
**描述:** 取服务端签名 mint 交易（mintSigned / mintAllowList / mintPublic）

**请求体:** `{ minter, quantity }`

**错误码:**
| 错误码 | 说明 |
|--------|------|
| 401 | API key 无效 |
| 409 | drop 未开/已结束/暂停 |
| 422 | 不满足条件（非白名单/额度/余额） |
| 429 | 限频 |

### 链上 SeaDrop 单例（0x00005EA00Ac477B1030CE78506496e8C2dE24bf5）

| 方法 | 说明 |
|------|------|
| getPublicDrop(nftContract) | 读价格/开售时间/上限/feeBps |
| getAllowedFeeRecipients(nftContract) | 读允许的费用接收方 |
| mintPublic(nftContract, feeRecipient, minterIfNotPayer, quantity) | 公售 mint，minterIfNotPayer=0 时 calldata 各钱包相同 |

### RPC JSON-RPC

| 方法 | 用途 |
|------|------|
| eth_chainId | 校验 RPC 归属链 |
| eth_getTransactionCount (pending) | 预取 nonce |
| eth_sendRawTransaction | 并发广播签名交易 |
| eth_getTransactionReceipt | 回执轮询 |
| eth_call | 发送前链上模拟 |