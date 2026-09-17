# rpc 模块

## 目的
链注册表与 RPC 端点选择/校验，保证签名前确认节点归属链。

## 模块概述
- **职责:** CHAINS 注册表（ethereum/base/robinhood/arc，含每链 gas 默认值）；resolveRpcsForChain 选择顺序（手动输入 > .env > 公共）；planRpcs 探测 chainId 并排序（可查询端点置前，纯发送端点保留）；verifyChainId；maskRpc 隐藏 key
- **状态:** ✅稳定
- **最后更新:** 2026-09-17

## 规范
### 需求: RPC 选择与链校验
**模块:** rpc
- 解析顺序: RPC_URL_<CHAIN> → (RPC_URL + EXTRA_RPC_URLS，仅当 CHAIN 匹配) → chains.ts 公共端点
- 报错链 ID 不同的端点直接丢弃；不响应 eth_chainId 的端点保留为纯发送（如 Base/Robinhood sequencer）
- **扫描角色分离**（`resolveScanRpcs`）：日志扫描需要宽 `eth_getLogs` 范围，与发送偏好相反。顺序为 `SCAN_RPC_URL_<CHAIN>`（若配置）→ 公共端点 → `.env` 私有端点；扫描/审计使用它，批量发送仍用 `resolveRpcsForChain`（私有优先）
- 扫描遇到"范围过小"类拒绝（Alchemy 免费档 10 块）会**切换端点**；遇到"结果过多"类拒绝会采用节点建议范围或二分（`isRangeError`/`parseRangeHint`/`isEndpointUnusable`），且这类确定性错误不再重试
- `gas: { maxFeeGwei, priorityGwei }` 为每链默认上限，`.env` 的 `MAX_FEE_PER_GAS`/`MAX_PRIORITY_FEE` 为空时生效；Arc 为 40/0（base fee ≈ 20 gwei）

### 需求: Arc 支持
**模块:** rpc
- chainId 5042，RPC `https://rpc.mainnet.arc.io`，浏览器 `https://explorer.arc.io`，原生 gas 为 USDC（18 位小数）
- SeaDrop 1.0 单例与 Ethereum/Base/Robinhood 同地址，`buildLocalMintPlan`/`fetchMintStats` 已实测可用
- 暂无已知的 send-only sequencer 端点；Alchemy host 未配置（裸 key 不会自动展开）

## API接口
### 导出
- `resolveRpcsForChain(chainKey, manual)` → `{ urls, source }`
- `planRpcs(urls, expectedChainId)` → RpcPlan（urls/verified/dropped/sendOnly/failures）
- `toRpcUrl(value, chainKey)`、`maskRpc(url)`、`verifyChainId(rpcUrl)`
- `resolveChain(idOrKey)`、`explorerTx(idOrKey, txHash)`

## 数据模型
ChainProfile: `{ key, chainId, name, explorer, nativeSymbol, gas: { maxFeeGwei, priorityGwei }, rpc: { alchemyHost, public[] } }`

## 依赖
- 无内部依赖（纯工具）

## 变更历史
- [202609141442_zh-cn-i18n](../../history/2026-09/202609141442_zh-cn-i18n/) - 越南语文案翻译为简体中文
- [202609141521_cli-en](../../history/2026-09/202609141521_cli-en/) - CLI 文案英文化 + 时区切换为 UTC+8
- [202609171345_arc-chain](../../history/2026-09/202609171345_arc-chain/) - 新增 arc 链与按链 gas 默认值
