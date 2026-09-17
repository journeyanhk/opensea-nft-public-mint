# batch-watch 模块

## 目的
批量模式的热加载与执行账本：常驻进程定期重读配置，把新导出/新写入的目标自动并入队列，并保证进程重启后不会重复发送已经广播过的目标。

## 模块概述
- **职责:** `--watch` 轮询（主配置 + 附加文件）；`mergeRawConfigs` 合并去重；队列差异（新增/移除）；`.batch-state.json` 执行账本（原子写）；`shouldSkipLedger` 跳过规则
- **状态:** ✅稳定
- **最后更新:** 2026-09-17

## 规范
### 需求: 队列热加载
**模块:** batch-watch
- `--watch [file...]`：每 `--watch-interval`（默认 60 秒）重读主配置与附加文件；主配置优先，目标按 `slug` 小写去重
- 新目标经由 `loadBatchConfig` 解析校验、通过 `maxPriceEth` 护栅与**逐目标余额预检**（`mint value + gasLimit × maxFee`）后才入队；不合格只跳过该目标并记录
- 队列按开售时间排序；配置中消失且未执行的目标移出队列并记录
- 长时间等待期间轮询仍在进行：执行器交接前（审计窗口）按 interval 分片等待，每片后重读配置
- 文件半写/解析失败时保留上一版队列并告警；`--watch` 后未显式给主配置时，若默认 `targets.json` 不存在则取第一个被 watch 的文件作为主配置

### 需求: 执行账本
**模块:** batch-ledger
- `.batch-state.json`（`version: 1`，原子写：临时文件 + rename）：`entries[chain][contract] = { status, txHash, at, quantity, slug }`
- 发送前先写 `PENDING`；返回后按结果更新：任一钱包有 `txHash` 则记该结果与哈希，全为 SKIPPED/REJECTED 记 SKIPPED，其余记 REJECTED
- 跳过规则（`shouldSkipLedger`）：`txHash !== null` 一律跳过；SUCCESS/REVERTED/TIMEOUT 跳过；PENDING 跳过（除非 `--retry-pending`）；SKIPPED/REJECTED 允许重试
- 审计判定跳过（等级命中 `auditSkipGrades`）也记账为 SKIPPED（未上链，允许后续重试）
- 执行抛错时保持 PENDING 并提示（`--retry-pending` 才重发），避免"可能已广播"被重复发送
- `--no-ledger` 关闭保护（不推荐）；账本路径可注入（测试用）

## API接口
### 导出
- `runBatch(configPath, options)`（batch-runner）：`{ watch, watchFiles, watchIntervalMs, ledger, retryPending, ledgerPath, maxPolls }`
- `mergeRawConfigs(main, extras)`、`rawTargetKey(target)`、`diffKeys(previous, incoming)`（batch-watch，纯函数）
- `loadLedger`/`saveLedger`/`recordEntry`/`entryOf`/`shouldSkipLedger`/`emptyLedger`（batch-ledger）

## 数据模型
```jsonc
// .batch-state.json（gitignore）
{
  "version": 1,
  "entries": {
    "arc": {
      "0xcddb…80df": { "status": "SUCCESS", "txHash": "0x…", "at": "2026-09-17T08:00:00Z", "quantity": 1, "slug": "0xCDDb…" }
    }
  }
}
```

## 依赖
- batch-config / local-mint / audit / rpc-resolver / prompt

## 变更历史
- [202609171655_m3-pipeline](../../history/2026-09/202609171655_m3-pipeline/) - M3a：`--watch` 队列热加载与 `.batch-state.json` 执行账本
