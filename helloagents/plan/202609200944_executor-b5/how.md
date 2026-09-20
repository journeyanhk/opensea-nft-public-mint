# 怎么做: B5 执行队列 + 面板按钮 + 独立执行器

目录: `helloagents/plan/202609200944_executor-b5/`

## 队列协议（磁盘即真相）

`queue/<ISO>-<chain>-<contract>.json`：
```
{ id, createdAt, createdBy: "panel", status: "queued" | "claimed" | "running" | "done" | "failed" | "cancelled",
  chain, contract, slug, name, quantity, maxPriceEth, maxValueWei, budgets: { gasLimit, maxFeePerGas },
  source: { kind: "favorite" | "row" | "bulk", note? },
  armRequired: true,
  lease: { by: "executor-hostname", expiresAt } | null,
  attempts: 0, result: { status, txHash, txHashes?, mintedCount, tokenIds?, gasBurnedWei, at } | null, error: null }
```
- 纯函数 `src/executor/queue.ts`：`enqueue`、`claimNext`（原子 rename → `.claimed`）、`complete`、`fail`、`cancel`（仅 queued）、`reclaimStale`（lease 过期 + attempts<2）
- `queue/ARMED` 存在 = 已武装；`queue/PAUSED` = 暂停拉取（执行器仍可写回已认领结果）

## serve 侧（无密钥）

- `POST /api/queue`：`{ chain, contract, quantity, maxPriceEth?, source? }` → 校验（链白名单、地址正则、quantity ≤ 20、maxPrice 合法）→ 写队列文件
- `GET /api/queue`：任务列表（脱敏，绝不含密钥）
- `POST /api/queue/cancel`：`{ id }`，仅 `queued`
- `POST /api/queue/arm`：`{ armed: true|false }` → 创建/删除 `queue/ARMED`
- 面板：行与收藏列表加「加入队列」；新增「队列」tab（状态、tx 链接、mintedCount、取消/重试按钮）；顶部 disarm 醒目提示

## 执行器（独立进程 + 密钥）

- 入口 `npm start -- --executor [--queue-dir queue] [--interval-ms 1500] [--once]`
- 启动断言：**必须有** `PRIVATE_KEY(S)`（与 serve 相反），否则拒绝启动；加载 `.env.executor`
- 循环：`reclaimStale → claimNext`（仅当 `ARMED` 且未 `PAUSED`）→ 构造一次性 batch 配置（复用 `loadBatchConfig` + `localPublicSnipe`，含三道门/burst/账本）→ 写回 `result`；进度写 `running` 心跳
- 与 CLI 互斥：执行器启动时以 `run-lock` 思路占用 `.batch-state.json` 与队列目录；手动 `--batch` 检测到锁时提示
- 系统化：`deploy/nft-executor.service`（User=nft、ReadWritePaths=仓库、NoNewPrivileges、私钥只在该单元的 EnvironmentFile）
- 通知（可选）：任务结束时按 `NOTIFY_WEBHOOK` 发一条 JSON（默认关闭）

## 安全与预算

- 入队即校验：`maxValueWei` 与 `gasLimit×maxFee×burstCount` 之和 ≤ 每任务上限；每小时入队数上限（默认 10）
- 武装状态：默认每次执行器启动回到**未武装**（`EXECUTOR_ARM_PERSIST=1` 可改为持久）
- 执行器对每个任务复用 B2 三道门与 B3 护栏；`NO_MINT/PARTIAL` 与账本去重照旧

## 验证

1. `tests/queue.cjs`：入队/认领/完成/取消/陈旧租约回收；非法输入被拒
2. `tests/serve.cjs`：`/api/queue` 四个端点 + 守卫 + 脱敏
3. `tests/executor.cjs`：claim → 构造配置 → 结果写回（用假 RPC/注入 snipe 函数）
4. 端到端（真链）：面板入队一个免费目标 → 武装 → 执行器 dry-run 模式先跑 → 去 dry-run 真跑，确认面板显示 `SUCCESS ×1` 与 tx 链接
