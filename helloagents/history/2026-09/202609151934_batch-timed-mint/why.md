# 变更提案: 多目标顺序定时 mint（batch 模式）

## 需求背景

现有工具是纯交互向导，一次只处理一个目标（`src/wizard.ts` 的 `runWizard`）。用户需要按开售时间依次自动执行同一条链上的多个 collection，例如：

- `https://opensea.io/collection/hoodminers-rh/overview` — Robinhood Chain，18:00 UTC 开售，免费，每钱包 1 个，公售仅 1 小时
- `https://opensea.io/collection/stock-salesman/overview` — 同链，18:30 UTC 开售，0.01 ETH，每钱包 3 个

痛点是每个目标都要人工在开售前守着向导操作，且向导当前在**开售前很久就完成签名**，无法应对 owner 在开售前 `updatePublicDrop` 改价/改期（上一轮 Catonchain 团灭的直接教训）。

用户提供了改造草案，经代码核验：骨架可行，但有 2 处引用了不存在的函数（`toSlug`、`promptKeysHidden`），且只重读价格、未重锚 `startTime`。选定"附件方案 + 加固"方向。

## 变更内容

1. 新增 `targets.json` 配置 + `src/batch-config.ts`：解析 slug/链接 → 合约，读链上公售，按开售时间排序，clamp 数量到链上上限，计算单目标价格上限。
2. 新增 `src/batch-runner.ts`：余额预检 → 打印日程 → **单次确认** → 逐个执行 → 汇总表；`onFailure: continue|stop`。
3. 改造 `src/local-mint.ts`：签名推迟到 **T-3s**，重读参数并**重锚 `startTime`**，加入 `maxValueWei` 价格护栏，返回 `SnipeResult[]`（向导路径行为不变，忽略返回值即可）。
4. `src/index.ts` 新增 `--batch <file>` 入口，保留原有向导/allowlist 分支。
5. gas / RPC / 密钥默认值**复用 `.env` 与现有 resolver**（`rpc-resolver.ts` / `wallet-keys.ts`），`targets.json` 只声明目标，避免配置双份漂移。
6. 同步知识库（wiki modules、arch、CHANGELOG、history）与 README。

## 影响范围

- **模块:** local-mint、wizard（仅导出 `promptKeys`）、index；新增 batch-config、batch-runner
- **文件:** `src/local-mint.ts`、`src/wizard.ts`、`src/index.ts`、新增 `src/batch-config.ts`、`src/batch-runner.ts`、新增 `targets.json`、`tests/batch-config.cjs`
- **API:** `localPublicSnipe` 返回值由 `void` → `Promise<SnipeResult[]>`（向后兼容）
- **数据:** 新增 `targets.json` 配置结构；无链上数据变更

## 核心场景

### 需求: 顺序定时执行多目标
**模块:** batch-runner / local-mint

#### 场景: 同链两目标相隔 30 分钟
在首个目标开售前启动，`wallets=env`，单次确认后无人值守。
- 打印两个目标的 UTC+8 开售时间、数量、单目标价格上限与总预算
- 到目标 A 的 T-3s 重读链上参数并校验，T-0 广播，等回执
- A 结束后继续等待目标 B，nonce 各自在 T-3s 时拉取，互不冲突
- 全部结束后输出汇总表（目标 / 钱包 / 状态 / txHash）

#### 场景: 开售前 owner 改价或改期
- 新价格 × 数量 > `maxValueWei` → 该目标全部钱包标记 `SKIPPED`，不发送
- 新 `startTime` 晚于原计划 → 重新对齐到新开售时间的 T-3s 再执行
- 新的费用接收人/calldata 变化 → 打印差异并采用新值

#### 场景: 余额不足
- 启动预检：单个钱包余额是否 ≥ Σ(每目标 value + `gasLimit × maxFee`)
- 任一钱包不足 → 打印缺口并抛错退出，不发送任何交易

#### 场景: 目标已结束或非 SeaDrop 公售
- 已过 `endTime` → 跳过并提示
- `buildLocalMintPlan` 返回 null（非 SeaDrop/无公售）→ 配置加载期报错

## 风险评估

- **风险:** 私钥泄露。**缓解:** 仅从 `.env` 或隐藏输入读取，绝不落盘/回显，仅打印钱包地址。
- **风险:** 本机时钟漂移导致错过区块。**缓解:** 以链上 `startTime` 为基准，文档提示同步 NTP。
- **风险:** HoodMiners 免费且 1 小时窗口、公售前有白名单，可能秒空。**缓解:** 排第一、`maxPriceEth=0`；售罄回执记为 `REVERTED` 并继续下一目标，不影响 B。
- **风险:** owner 改期导致 T-0 提前 revert `NotActive`。**缓解:** T-3s 重读并重锚 `startTime`。
- **风险:** 两个目标开售时间相同时串行队列失效（nonce 冲突）。**缓解:** 当前两目标相隔 30 分钟；文档明确此限制，不实现并行（YAGNI）。
- **风险:** 整批仅支持单链。**缓解:** 配置只允许一个 `chain`，跨链需分开运行。
- **风险:** 白名单阶段需 OpenSea 服务端签名，无法预签名入队。**缓解:** 文档说明白名单资格走原有 `--allowlist`，队列只处理公售。
