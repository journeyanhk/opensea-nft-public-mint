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
- [ ] 3.1 `calibrateLead`（RTT p50 + 时钟偏差 + 50ms）与偏差阈值
- [ ] 3.2 `planBurst` nonce 计划 + 预算/过铸护栏（cap==1 默认可多发）
- [ ] 3.3 `local-mint` 连发与结果聚合（预期内回滚 vs 真失败；gas 燃烧入账）
- [ ] 3.4 清理 `timer.ts` 死参数（`earlyFireMs` → `leadMs`）
- [ ] 3.5 `tests/burst.cjs`

## 4. B4 协调器
- [ ] 4.1 `src/batch-coordinator.ts`：通道分配/释放、预算预留、冲突排序
- [ ] 4.2 跨进程钱包锁（OS 端口互斥 + pid + token）
- [ ] 4.3 `--parallel` 接线（默认串行不变）
- [ ] 4.4 `tests/coordinator.cjs`

## 5. 收尾
- [ ] 5.1 全量测试 + `--dry-run` 真链演练记录
- [√] 5.2 README（新 flag/语义）、wiki（batch/ledger/backfill）、CHANGELOG
- [ ] 5.3 方案包迁移 + 推送

## review13 修复（B1/B2 部署前，同日）

- [√] Gate 3：开售前跳过、开售后并行；`refreshBeforeMs` 3s→5s
- [√] SeaDrop 自定义错误按选择器解码（4byte 核对；两种 NotActive 元数）+ 未知选择器兜底；测试用真实选择器
- [√] `--dry-run` 余额不足仅警告
- [√] favorites API 输入校验（链白名单/地址正则/长度/体积）
- [√] 门 1 代理盲区（EIP-1967）记录为后续项，未实现
