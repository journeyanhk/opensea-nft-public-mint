# batch 模块

## 目的
批量模式：从 `targets.json` 读取多个目标，按开售时间升序无人值守依次执行公售 mint。

## 模块概述
- **职责:** 加载并校验配置（slug/链接 → 合约 → 链上公售）；数量 clamp 到链上单钱包上限；计算单目标价格上限；RPC 选择与 chainId 校验；余额预检；单次确认；串行执行与汇总；`onFailure` 策略
- **状态:** ✅稳定
- **最后更新:** 2026-09-15

## 规范
### 需求: 顺序定时执行多目标
**模块:** batch
- 整批固定单条链；跨链需拆成两份配置
- gas / RPC / 密钥默认复用 `.env` 与现有 resolver（`rpc-resolver`、`wallet-keys`），JSON 中 `rpcs`/`gas` 为可选覆盖；gas 的 `.env` 缺省值按链（`ChainProfile.gas`，Arc 40/0）
- 广播前 gas 预检：读最新块 `baseFeePerGas`，`maxFeePerGas < baseFee` 直接报错退出（避免开售时才被节点以 base fee 拒收），并给出建议值
- `walletSource: env`（默认）用 `PRIVATE_KEY`/`PRIVATE_KEYS`；`prompt` 复用向导的隐藏输入流程（`promptKeys`，已导出）
- 目标按 `startAt` 升序排序；`startAt: "auto"` 取链上 `getPublicDrop().startTime`，也可用 ISO 时间覆盖
- 余额预检要求**每个**钱包 ≥ Σ(每目标 value + `gasLimit × maxFee`)，任一不足即报错退出
- 预检通过后**只确认一次**，随后 `closePrompts()` 并无人值守执行
- 执行单元内每个目标在 T-refresh 才拉 pending nonce，串行天然无 nonce 冲突；同刻开售的目标未支持（需改并行分支）
- `onFailure: continue`（默认）失败继续下一目标；`stop` 在整批无成功时提前结束
- 已过 `endTime` 的目标直接标记 SKIPPED
- 批量到达目标时若配置开售已过则传 `targetStart: null`；这不再等于"立刻发送"——链上 `startTime` 若仍在未来会被改为等待，提前开售也会即时对齐（由 local-mint 的 `reconcileStart` 裁决）
- 安全：`targets.json` 会随仓库提交，禁止把带 API key 的 RPC 写入其 `rpcs`；RPC 统一放 `.env`，或改用已被 `.gitignore` 忽略的 `targets.local.json`
- 加载时以 minter=0x0 读一次 `getMintStats` 存入 `BatchTarget.supply`；BATCH SCHEDULE 每行追加 `已铸/上限`，剩余为 0 时标红 `SOLD OUT`。仅提示不自动跳过——开售前供应仍可能被提高，最终以 T-refresh 的检查为准

## API接口
### 导出
- `loadBatchConfig(raw, chain, rpcUrls)` → `Promise<BatchConfig>`：纯校验+链上读，不含交互
- `clampQuantity(quantity, maxTotalMintableByWallet)` → number（cap=0 视为不限）
- `computeMaxValueWei(maxPriceEth, quantity)` → bigint
- `sortTargetsByStart(targets)` → BatchTarget[]（副本排序，不改原数组）
- `resolveGas(chainKey, override)` → `{ maxFeePerGas, maxPriorityFee, gasLimit }`，tip > ceiling 抛错
- `runBatch(configPath)` → Promise<void>：完整批量编排

## burst（M8/B3）
- `calibrateLead` 的时钟偏差**必须**用秒跳变观测（直接 `now − ts×1000` 会因秒级截断产生 0–1000ms 假偏差，约一半概率误触发 500ms 阈值）；观测不到时 `clockSkewMs = null` 且 `burstGate` 放行并标注 unknown
- `src/burst.ts`：`planBurst(baseNonce,count)`、`burstGate({count,capPerWallet,allowOvershoot,clockSkewMs,leadMs,forceClock})`、`aggregateBurst(shots)`（取落地的 shot、gas 全量求和）、`calibrateLead`（p50 RTT + 时钟偏差 + 余量，可注入 measureRtt/fetchFn/now）
- `batch-config.burst = { count, spacingMs, leadMs, allowOvershoot, forceClock }`（`parseBurst` 夹取范围：count 1..5、spacing 50..1000、lead ≥50 或 auto）
- `batch-runner`：批量开始时校准一次并打印 `lead/rtt/skew`；每个目标用 `burstGate` 决策（不通过则降级为单发并告警，不是拒绝执行）；余额预检按 `count × gasLimit × maxFee` 预留
- `local-mint`：按 `count` 逐 nonce 签名并过 Gate 2；开售时先 `T-leadMs` 发第一发，随后每 `spacingMs` 一发；逐钱包 `aggregateBurst` 得最终状态与 tokenIds；`dry-run` 打印全部将发 hash
- 账本：`txHashes`（全部 shot），`txHash` 为落地的那一笔；`gasBurnedWei` 含预期内回滚

## 数据模型
- `targets.json`:
  - `chain`（必填）、`walletSource`、`refreshBeforeMs`、`onFailure`
  - `rpcs?`、`gas?`（可选覆盖）
  - `targets[]`: `{ slug, quantity?, maxPriceEth?, startAt? }`
- BatchTarget: `{ label, contract, quantity, maxValueWei, startAt, plan, supply }`，`supply = { totalMinted, maxSupply } | null`（合约不响应时为 null）
- BatchConfig: `{ chainKey, walletSource, rpcUrls, maxFeePerGas, maxPriorityFee, gasLimit, refreshBeforeMs, onFailure, targets }`
- 付费目标必须显式 `maxPriceEth`，否则加载期报错；当前价已超上限则警告（执行时会被 SKIPPED）

## 依赖
- batch-config / local-mint / rpc-resolver / keys(wallet-keys) / wizard(promptKeys) / chains / time-format / prompt / ethers

## 变更历史
- [202609171655_m3-pipeline](../../history/2026-09/202609171655_m3-pipeline/) - M3a 热加载与执行账本（见 [batch-watch](batch-watch.md)）
- [202609151934_batch-timed-mint](../../history/2026-09/202609151934_batch-timed-mint/) - 新增批量模式与 targets.json 配置
- [202609152008_review-fixes](../../history/2026-09/202609152008_review-fixes/) - 开售时间漂移（planned=null / 提前）处理与 RPC key 入库提醒
- [202609161339_supply-check](../../history/2026-09/202609161339_supply-check/) - BATCH SCHEDULE 显示已铸/上限并标红售罄；T-refresh 增加 getMintStats 售罄与单钱包上限检查
- [202609171345_arc-chain](../../history/2026-09/202609171345_arc-chain/) - Arc 链支持、gas 按链默认、广播前 base fee 预检
