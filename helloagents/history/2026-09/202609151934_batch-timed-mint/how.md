# 技术设计: 多目标顺序定时 mint（batch 模式）

## 技术方案

### 核心技术
- TypeScript 5.3 / Node.js 18+ / ethers 6；不引入新依赖
- 复用现有执行单元：`buildLocalMintPlan`（seadrop-public）、`blastToAll`/`waitForReceipt`（rpc-blast）、`waitForMintTime`（timer）、`resolveSlug`（slug-resolver）、`resolveRpcsForChain`/`planRpcs`（rpc-resolver）、`walletKeysFromEnv`（wallet-keys）

### 实现要点

- **配置层最小化。** `targets.json` 只声明链、目标列表与少量策略字段；gas / RPC / 密钥默认从 `.env` 读取（与向导同一批 resolver 和默认值），JSON 仅作为可选覆盖。避免"JSON 一套、.env 一套"漂移。
- **执行单元改造（local-mint）。** `localPublicSnipe` 增加可选参数 `maxValueWei`、`refreshBeforeMs`，返回 `Promise<SnipeResult[]>`；`refreshBeforeMs=0`（缺省）时行为与现状完全一致，向导零改动。
- **T-3s 三件事。** 到 `startAt - refreshBeforeMs` 后依次：(a) 重读 `buildLocalMintPlan`；(b) 若链上 `startTime` 晚于计划则**重锚**并重新等待；(c) `fresh.value > maxValueWei` 则 `SKIPPED`。之后才拉 pending nonce、签名、`prepareBlast`，再自旋等到 T-0 广播。
- **预热前置。** `warmConnections` 在 T-3s 之前完成，保证 T-3s→T-0 的窗口只做重读/签名/编码。
- **数量 clamp。** 每个目标数量取 `min(配置值, maxTotalMintableByWallet)`，0 视为不限。
- **串行 + 独立 nonce。** 逐目标调用执行单元，每个目标在 T-3s 才拉 pending nonce，前一目标已上链或明确失败，天然不冲突。

## 架构设计

```mermaid
flowchart TD
    A[src/index.ts --batch file] --> B[batch-runner]
    B --> C[batch-config 加载/校验/排序]
    C --> D[resolveSlug / buildLocalMintPlan]
    B --> E[余额预检 + 单次确认]
    B --> F{遍历目标}
    F --> G[local-mint localPublicSnipe]
    G --> H[T-3s 重读 + 重锚 + 价格护栏]
    H --> I[签名 + prepareBlast]
    I --> J[rpc-blast 多 RPC 广播]
    J --> K[waitForReceipt 回执]
    K --> F
    F --> L[汇总表]
    C -. 复用 .env .-> M[rpc-resolver / wallet-keys]
```

数据流（单目标）：
`targets.json` → `parseNftLink`/`resolveSlug` → 合约地址 → `buildLocalMintPlan` → `LocalMintPlan`（初始）→ 排序 → 预检 → 执行时 T-3s 重读为 `fresh` → `SnipeResult[]` → 汇总。

## 架构决策 ADR

### ADR-4: 顺序单队列而非并行
**上下文:** 两个 Robinhood 目标相隔 30 分钟、同链同 SeaDrop 单例；并行会引入每钱包 nonce 预分配与失败重排的复杂度。
**决策:** 单队列按 `startAt` 升序串行执行，每个目标执行时才拉 nonce。
**理由:** 两个目标时间不重叠，串行即可完全覆盖需求，实现与验证成本最低（YAGNI）。
**替代方案:** 并行分支 + 预分配 `nonce+i` → 拒绝原因: 当前无同刻开售场景，收益为零而风险显著上升。
**影响:** 若未来出现同刻开售目标，需扩展并行支路；文档标注该限制。

### ADR-5: 配置复用 `.env`，`targets.json` 只列目标
**上下文:** 附件草案在 JSON 内重复声明 `rpcs`/`gas`，与 `.env`（`RPC_URL_ROBINHOOD`/`MAX_FEE_PER_GAS`/`GAS_LIMIT`）形成两份事实源，易漂移。
**决策:** 默认走 `.env` + `rpc-resolver`；JSON 中 `rpcs`/`gas` 为可选覆盖，缺省即省略。
**理由:** 单一事实源，减少配置错误面。
**替代方案:** 全部放 JSON → 拒绝原因: 与现有安装流程（生成 `.env`）割裂。
**影响:** 用户只需维护一份 gas/RPC。

### ADR-6: 签名推迟到 T-3s，并重读+重锚 startTime（取代附件草案的"只重读价格"）
**上下文:** owner 可在开售前 `updatePublicDrop` 改价或改期；附件仅在 T-3s 比对 `data/value`，改期会让 T-0 强发 revert `NotActive`。
**决策:** T-3s 重读后同时校验价格与 `startTime`；价格超 `maxValueWei` 走 `SKIPPED`，`startTime` 后移则重锚等待；参数变化采用新值。
**理由:** 用 3 秒余量换取对链上最新状态的顺从，避免"预签即过期"。
**替代方案:** 保持开售前提前签名（现状）→ 拒绝原因: 无法应对改价/改期，正是 Catonchain 教训。
**影响:** T-3s~T-0 窗口需容纳一次 RPC 读 + 一次签名；钱包数 >20 时提高 `refreshBeforeMs`。

### ADR-7: 复用向导按键逻辑而非复制
**上下文:** 附件草案引用不存在的 `promptKeysHidden()`；向导内已有隐藏输入逻辑 `promptKeys()`（私有）。
**决策:** 将 `wizard.ts` 的 `promptKeys` 加 `export` 供 batch-runner 复用；`walletSource: "env"` 走 `walletKeysFromEnv()`。
**理由:** 避免复制密钥解析与去重逻辑（该逻辑涉及安全，不应有两份）。
**替代方案:** 在 batch-runner 复制一份 → 拒绝原因: 安全相关逻辑重复维护。
**影响:** wizard.ts 仅加一个 `export` 关键字，无逻辑改动。

## API设计

### `localPublicSnipe(opts): Promise<SnipeResult[]>`
- **请求:** 原 `LocalSnipeOpts` + `maxValueWei?: bigint` + `refreshBeforeMs?: number`
- **响应:** `SnipeResult[]`，`status ∈ SUCCESS | REVERTED | TIMEOUT | REJECTED | SKIPPED`，含 `idx/address/txHash`
- **兼容:** 现有向导调用忽略返回值，行为不变

### `loadBatchConfig(path, rpcUrls): Promise<BatchConfig>`
- **请求:** 配置文件路径 + 已解析的 RPC 列表
- **响应:** `{ chainKey, walletSource, rpcUrls, maxFeePerGas, maxPriorityFee, gasLimit, refreshBeforeMs, onFailure, targets: BatchTarget[] }`

### `runBatch(path): Promise<void>`
- 入口编排：加载 → 预检 → 确认 → 逐目标执行 → 汇总

## 数据模型

```jsonc
// targets.json
{
  "chain": "robinhood",            // 必填，整批同链
  "walletSource": "env",           // 可选，env(默认) | prompt
  "refreshBeforeMs": 3000,         // 可选，默认 3000；钱包多可调大
  "onFailure": "continue",         // 可选，continue(默认) | stop
  "rpcs": ["https://..."],         // 可选覆盖，缺省用 .env + 公共节点
  "gas": {                         // 可选覆盖
    "maxFeeGwei": 2, "priorityGwei": 0.05, "gasLimit": 250000
  },
  "targets": [
    { "slug": "hoodminers-rh",  "quantity": 1, "maxPriceEth": "0",    "startAt": "auto" },
    { "slug": "stock-salesman", "quantity": 3, "maxPriceEth": "0.01", "startAt": "auto" }
  ]
}
```

- `slug`: OpenSea 链接 / slug / 合约地址（经 `parseNftLink`）
- `maxPriceEth`: 单价上限，护栏；总价上限 = `maxPriceEth × clamp(quantity)`
- `startAt`: `"auto"`（用链上 `startTime`）或 ISO 时间覆盖

## 安全与性能

- **安全:** 私钥仅内存/`.env`，不回显不落盘；错误信息过滤私钥（沿用 `wallet-keys.ts` 现有做法）；广播前仅打印地址与 txHash。
- **性能:** 预热连接前置；T-3s 只做一次 RPC 读 + 签名 + keccak 编码；广播为 fire-and-forget 并发到全部 RPC。

## 测试与部署

- **测试:** `npm run build` 通过；`node --test tests/` 通过；新增纯函数单测（数量 clamp、价格上限换算、目标排序）不依赖网络。
- **手工验证:** 以 `startAt` 设为近期时间、`maxPriceEth` 设 0 对免费测试 collection（tadaaaaaa）跑一次 `--batch`，确认预检/确认/汇总与向导结果一致。
- **部署:** 本地 CLI，无部署；`npm run build && npm start -- --batch targets.json`，建议 tmux/screen 常驻。
