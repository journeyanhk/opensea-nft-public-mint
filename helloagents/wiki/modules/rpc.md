# rpc 模块

## 目的
链注册表与 RPC 端点选择/校验，保证签名前确认节点归属链。

## 模块概述
- **职责:** CHAINS 注册表（ethereum/base/robinhood）；resolveRpcsForChain 选择顺序（手动输入 > .env > 公共）；planRpcs 探测 chainId 并排序（可查询端点置前，纯发送端点保留）；verifyChainId；maskRpc 隐藏 key
- **状态:** ✅稳定
- **最后更新:** 2026-09-14

## 规范
### 需求: RPC 选择与链校验
**模块:** rpc
- 解析顺序: RPC_URL_<CHAIN> → (RPC_URL + EXTRA_RPC_URLS，仅当 CHAIN 匹配) → chains.ts 公共端点
- 报错链 ID 不同的端点直接丢弃；不响应 eth_chainId 的端点保留为纯发送（如 Base/Robinhood sequencer）

## API接口
### 导出
- `resolveRpcsForChain(chainKey, manual)` → `{ urls, source }`
- `planRpcs(urls, expectedChainId)` → RpcPlan（urls/verified/dropped/sendOnly/failures）
- `toRpcUrl(value, chainKey)`、`maskRpc(url)`、`verifyChainId(rpcUrl)`
- `resolveChain(idOrKey)`、`explorerTx(idOrKey, txHash)`

## 数据模型
ChainProfile: `{ key, chainId, name, explorer, nativeSymbol, rpc: { alchemyHost, public[] } }`

## 依赖
- 无内部依赖（纯工具）

## 变更历史
- [202609141442_zh-cn-i18n](../../history/2026-09/202609141442_zh-cn-i18n/) - 越南语文案翻译为简体中文