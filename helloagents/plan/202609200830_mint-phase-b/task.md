# 任务清单: 阶段 B（mint 执行侧）

目录: `helloagents/plan/202609200830_mint-phase-b/`

---

## 1. B1 回执核数量
- [√] 1.1 `src/receipts.ts`：`countMintedTokens`（ERC-721 Transfer(0→wallet) / ERC-1155 TransferSingle|Batch）、`verdict`
- [√] 1.2 `local-mint.ts` 用 verdict 取代 `receipt.status`；`SnipeResult` 带 mintedCount/tokenIds
- [√] 1.3 账本 `mintedCount/tokenIds/gasBurnedWei`；`shouldSkipLedger` 接入 PARTIAL/NO_MINT（终态）
- [√] 1.4 回填按 token 摊分成本；面板执行列显示真实结果
- [√] 1.5 `tests/receipts.cjs`（真实回执 fixture + 真值表）+ 账本/回填/面板断言

## 2. B2 三道门
- [√] 2.1 codeHash：`buildLocalMintPlan` 返回、审计落状态、导出进 targets.json、T-3s 复核
- [√] 2.2 `validateSigned`（Transaction.from 逐字段 + calldata 解码断言）；篡改必须被拒
- [√] 2.3 pending 模拟门 + revert 原因解码（NotActive 视为通过）
- [√] 2.4 `--dry-run`（签名 + 模拟，不广播）
- [√] 2.5 `tests/gates.cjs`

## 3. B3 burst
- [√] 3.1 `calibrateLead`（RTT p50 + 时钟偏差 + 50ms）与偏差阈值
- [√] 3.2 `planBurst` nonce 计划 + 预算/过铸护栏（cap==1 默认可多发）
- [√] 3.3 `local-mint` 连发与结果聚合（预期内回滚 vs 真失败；gas 燃烧入账）
- [√] 3.4 清理 `timer.ts` 死参数（`earlyFireMs` → `leadMs`）
- [√] 3.5 `tests/burst.cjs`

## review14 修复（B3，同日）

- [√] `calibrateLead` 秒跳变观测（±100ms）+ `clockSkewMs: null` 语义（unknown 不拒绝）
- [√] overshoot 预算 `value × count`
- [√] nonce gap 检测/告警/入账

## 4. B4 协调器
- [√] 4.1 `src/batch-coordinator.ts`：`LaneCoordinator`（独占租约/仅持有者释放/过期自动回收）、`planReservation`（gas×发数，overshoot 时 value×发数）、`orderJobs`（按开售排序 + 5s 窗口同钱包冲突）
- [√] 4.2 `src/wallet-lock.ts`：OS 端口互斥（进程死即释放）+ pid/token 文件（只认 ESRCH 才回收旧锁）
- [ ] 4.3 `--parallel` 接线（默认串行不变）
- [√] 4.4 `tests/coordinator.cjs`

## review15 修复（B4，同日）

- [√] 租约 `renew` + 竞争用例；`expire` 语义改为崩溃回收
- [√] 累计预留（`reserve/unreserve/reservedTotal` + 上限/缺口）
- [√] 端口误报回退 + 真实占用判定
- [√] nonce 空洞自动补洞（`gapFillerTx`）
- [√] `beforeSend` 钩子 + 批量启动钱包锁
- [√] `TargetJob` 状态机（`src/target-job.ts` + 3 用例）：waiting/preparing/sending/receipt/done|failed|skipped 与 `jobsToPrepare`
- [√] 余额由 `reservedTotal` 驱动（enqueue 先 claim、pre-check 用累计预留、差额提示；`--watch` 合并周期重试）
- [√] schedule 冲突告警（`orderJobs`，同钱包 <5s）
- [ ] `--parallel` 并发执行（`jobsToPrepare` + `beforeSend` 通道已就绪，目标循环抽取为 job 函数即可）+ `TargetSource` 接口（B5 队列复用）

## 5. 收尾
- [ ] 5.1 全量测试 + `--dry-run` 真链演练记录
- [√] 5.2 README（新 flag/语义）、wiki（batch/ledger/backfill）、CHANGELOG
- [ ] 5.3 方案包迁移 + 推送

## review13 修复（B1/B2 部署前，同日）

- [√] Gate 3：开售前跳过、开售后并行；`refreshBeforeMs` 3s→5s
- [√] SeaDrop 自定义错误按选择器解码（4byte 核对；两种 NotActive 元数）+ 未知选择器兜底；测试用真实选择器
- [√] `--dry-run` 余额不足仅警告
- [√] **修复**：dry-run 写 PENDING 账本导致真实运行被拒（三处写入统一守卫 + 不变式测试；受影响运行用 `--retry-pending` 恢复）
- [√] favorites API 输入校验（链白名单/地址正则/长度/体积）
- [√] 门 1 代理盲区（EIP-1967）记录为后续项，未实现
