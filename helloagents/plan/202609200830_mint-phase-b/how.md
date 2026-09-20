# 怎么做: 阶段 B（mint 执行侧）

目录: `helloagents/plan/202609200830_mint-phase-b/`

## B1 回执核数量（先做，其余都依赖它）

**新模块 `src/receipts.ts`（纯函数）**
- `countMintedTokens(receipt, { nftContract, wallet })`：解析 `Transfer(0x0→wallet)`（ERC-721，tokenId 取 topic）与 `TransferSingle/TransferBatch`（ERC-1155，数量取 data），返回 `{ count, tokenIds, kind }`；只认 `nftContract` 的日志。
- `verdict(status, minted, quantity)`：`MINTED`（minted ≥ quantity）/ `PARTIAL`（0 < minted < quantity）/ `NO_MINT`（status 成功但 0 个）/ `REVERTED` / `TIMEOUT`。

**接线**
- `SnipeStatus` 扩展 `PARTIAL`/`NO_MINT`；`local-mint.ts:365` 改为 `verdict(...)`；`SnipeResult` 增加 `mintedCount`、`tokenIds`。
- `LedgerEntry` 增加 `mintedCount: number`、`tokenIds: string[]`（上限 200，超出记 `tokenIdsTruncated: true`）、`gasBurnedWei`。
- `shouldSkipLedger`：`PARTIAL`/`NO_MINT` 与 `SUCCESS`/`TIMEOUT` 同为终态（**NO_MINT 绝不重发**）；`REVERTED` 的现有例外保持不变。
- `backfill.ts`：成本按 `mintedCount`（缺省回退 `quantity`）摊分；面板执行列 `SUCCESS ×3` / `PARTIAL 1/3` / `NO_MINT`。
- **测试**：ERC-721/ERC-1155 真实回执 fixture、verdict 真值表、账本合并、`shouldSkipLedger` 新状态、回填摊分。

## B2 三道门

1. **合约身份锁**：`buildLocalMintPlan` 返回 `codeHash = keccak256(eth_getCode(nft))` 与 SeaDrop 单例 codeHash；审计写入 `ContractEntry.codeHash`，导出时写进 `targets.json`；`local-mint` 在 T-3s 重读并比对，不一致 → `SKIPPED("contract code changed")`。
2. **签名复核**：新纯函数 `validateSigned(rawTx, expected)`（`Transaction.from`）逐字段核对 `from/chainId/to/nonce/data/value/gasLimit/maxFeePerGas`，并解码 `data` 为 `mintPublic` 断言 `nftContract/feeRecipient/minterIfNotPayer==0/quantity`；`value ≤ maxValueWei`。不通过直接抛错，不广播。
3. **pending 模拟**：T-2s 每钱包 `eth_call({from, to: SeaDrop, data, value}, "pending")`；`NotActive/NotStarted` 视为通过；其它 revert → 该钱包 `SKIPPED` + 解码原因（`MintQuantityExceedsMaxSupply`、`IncorrectPayment`、`FeeRecipientNotAllowed`、`AllowedFeeRecipientNotSet`…）。新增小错误解码器（复用 audit 的 ABI）。
- **测试**：篡改 quantity/feeRecipient 的签名必须被拒；revert 分类真值表；codeHash 变化 → SKIPPED；`NotActive` 不误判。

## B3 burst

- 配置：`--burst-count 1..5`、`--burst-spacing-ms 100`、`--burst-lead-ms auto|<n>`、`--allow-overshoot`；写进 `BatchConfig`。
- **提前量**：`calibrateLead({ rpcUrls, now })` = p50 RTT（5 次 `eth_blockNumber`）+ 时钟偏差（本地 now − 最新块时间戳）+ 50ms；偏差 >500ms 默认拒绝 burst。
- **nonce 计划（纯函数）**：`planBurst(baseNonce, count)`；每笔独立 nonce、同一 calldata、同一 gas 参数。
- **护栏**：`cap == 1` 才默认允许多发；`cap > 1` 需 `--allow-overshoot`；预算 `count × gasLimit × maxFee` 纳入该钱包预留与全局 `MAX_SPEND_WEI`。
- **结果聚合**：所有 hash 入账（`attempts`），终态取"最优"：任一 MINTED → MINTED（记录实际 mintedCount）；全部回滚 → REVERTED 并如实报告燃烧的 gas；**日志区分"预期内回滚（NotActive/exceeds cap）"与"真失败"**。
- `timer.ts` 的 `earlyFireMs` 自此被 `leadMs` 取代（死参数清理）。
- **测试**：nonce 计划、lead 计算（假时钟/假 RTT）、过铸门控、结果聚合、gas 燃烧统计。

## B4 钱包通道协调器

- `src/batch-coordinator.ts`：`WalletLane { address, owner, reservedWei, nonceFloor }`；`acquire(job, wallet)` / `release(wallet)`（回执或 60s 超时释放）。
- **跨进程锁**：`run-lock` 思路——以钱包地址哈希映射本地端口做 OS 级互斥 + pid 文件 + token（force-close 自动释放；只认 `ESRCH` 才清理）。
- **预算**：入队按 `value + gasLimit × maxFee`（× burst count）累加，超过余额/全局上限拒绝入队并给出差额。
- **并行**：`--parallel` 打开后所有目标并发 `run()`，发送经协调器；默认仍串行（行为向后兼容）。同钱包、开售相差 <5s 的冲突 → 告警并按优先级（配置显式优先，其次 Q 分）排序。
- **测试**：通道分配/释放、预算拒绝、冲突排序、锁的陈旧恢复（纯逻辑 + 临时文件）。

## 执行顺序与验证

| 顺序 | 内容 | 估时 | 依赖 |
|---|---|---|---|
| 1 | B1 回执核数量 + 账本/回填/面板 | 1 天 | 无 |
| 2 | B2 三道门（含 codeHash 落状态与导出） | 1 天 | B1（结果语义） |
| 3 | B3 burst（含 `--dry-run` 全程演练） | 1 天 | B2（模拟门是 burst 的安全前提） |
| 4 | B4 协调器 + `--parallel` | 1.5 天 | B3（burst 会占用通道更久） |

每步：纯函数先测（fixture 用真实回执/签名）、`npm run build && node --test tests/*.cjs` 全绿、文档同步、推送。**`--dry-run`（签名 + 模拟，不广播）建议在 B2 就引入**，用于部署前在真链上演练而零成本。

## 安全默认值（需 review 确认）

- burst **默认关闭**（`--burst-count 1` 即现状行为）；只自动算 lead，不自动开启连发。
- 过铸**默认拒绝**：`cap > 1` 时必须 `--allow-overshoot`，且仍受 `MAX_SPEND_WEI` 全局上限。
- 三道门 **fail-closed**：任一不通过 → 拒绝广播（不是警告后继续）。
- 时钟偏差 >500ms 或缺 RPC 计量 → burst 不可用（可 `--force-clock`）。
