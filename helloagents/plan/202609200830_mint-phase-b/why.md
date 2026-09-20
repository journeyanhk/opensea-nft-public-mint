# 为什么: 阶段 B（mint 执行侧）

## 背景（已核对现状）

The Obscura 的失败给出三条硬结论：**到达时间差在网络路径**（+3ms 发出、落后 5 个区块）、**tip 不是杠杆**（实付=base fee，sequencer 按到达顺序）、**单钱包对批量合约无对抗性**（一笔 1,000 个）。代码侧现状：

| 能力 | 现状 | 位置 |
|---|---|---|
| 预签名 + 多端点齐发 | 已有（T-0 只剩写 socket） | `local-mint.ts:265-299`、`rpc-blast.ts` |
| 提前量 | **`earlyFireMs` 是死参数**：`timer.ts` 支持，但没有调用方传非 0 | `timer.ts:4`、`local-mint.ts:288` |
| 成功判定 | **只看 `receipt.status`**：status==1 但铸到 0 个也算 SUCCESS | `local-mint.ts:365` |
| 合约/签名/模拟三道门 | 全无（签名后被替换、calldata 被篡改都不会发现） | — |
| 账本 | `{status, txHash, at, quantity, attempts, slug}`，无 token 数 | `batch-ledger.ts` |
| 多钱包/多目标 | 串行目标；同钱包无协调（`--parallel` 不存在） | `batch-runner.ts` |
| 预算 | 只有每钱包 `maxValueWei`，无全局上限、无 burst 预算 | `local-mint.ts:212` |

## 目标

- **B1 回执核数量**：`SUCCESS` = 真的收到 N 个 token（tokenIds 可查）；`PARTIAL`/`NO_MINT` 独立状态；账本记录 tokenIds 与 mintedCount，回填按 **token** 计成本；面板执行列显示真实结果。
- **B2 三道门**：合约 codeHash 锁定（审计/导出时记录，T-3s 复核）、广播前 `Transaction.from` 逐字段复核签名、T-2s `pending` 模拟（`NotActive` 视为通过，其它 revert 丢弃该钱包并给可读原因）。
- **B3 burst**：多 nonce 提前连发，`leadMs` 由 RTT + 时钟偏差 + 50ms 自动算出；**过铸与预算护栏**；gas 燃烧如实入账。
- **B4 钱包通道协调器**：每钱包一条通道（同钱包串行、不同钱包并行）、跨进程钱包锁、预算预留、冲突告警与优先级。

## 不在本包

- 克隆子钱包批量合约（独立立项：合约开发 + 审计 + 平台风险）。
- MEV bundle（Robinhood sequencer 按到达顺序，无 bundle 通道）。
- WS 实时、逐笔 Sale 样本采集（监控侧 B 之后再说）。

## 风险与对策

| 风险 | 对策 |
|---|---|
| burst 提前发出落进开售前的块 → `NotActive` 回滚烧 gas | 提前量自动校准但**默认保守**（只 lead，不缩短）；每次回滚 ≈25k gas，预算上限兜底；面板/日志把"预期内的回滚"与"真失败"分开统计 |
| 同一笔 burst 多笔成交 → 买到超过预期数量 | `cap == 1` 才默认允许多发（数学上只有一笔能成）；`cap > 1` 必须显式 `--allow-overshoot`，且受全局预算约束 |
| 合约被代理替换 / calldata 被篡改 | B2 三道门；任一不通过即拒绝广播（fail-closed） |
| 两个进程共用钱包 → nonce 冲突 | B4 跨进程锁（OS 端口互斥 + pid + token，抄 mint-desk 的 run-lock 思路） |
| 本地时钟偏差 > 提前量 | 启动时用最新区块时间戳估偏差；超过 500ms 默认拒绝 burst（可 `--force-clock`） |
