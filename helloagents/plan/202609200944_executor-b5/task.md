# 任务清单: B5 执行队列 + 面板按钮 + 独立执行器

目录: `helloagents/plan/202609200944_executor-b5/`

---

## 1. 队列数据层
- [ ] 1.1 `src/executor/queue.ts`：enqueue/claimNext（rename 原子认领）/complete/fail/cancel/reclaimStale + 输入校验
- [ ] 1.2 `tests/queue.cjs`

## 2. serve（无密钥）
- [ ] 2.1 API：POST /api/queue、GET /api/queue、POST /api/queue/cancel、POST /api/queue/arm
- [ ] 2.2 面板：行/收藏「加入队列」、队列 tab、武装状态条与醒目提示
- [ ] 2.3 `tests/serve.cjs` 端点与守卫 + 脱敏断言

## 3. 执行器
- [ ] 3.1 CLI `--executor`（`.env.executor`、必须有私钥的断言）
- [ ] 3.2 循环：reclaim → claim → 构造配置 → 复用管线（三道门/burst/账本）→ 写回
- [ ] 3.3 与 CLI 的互斥锁；`deploy/nft-executor.service`
- [ ] 3.4 `tests/executor.cjs`

## 4. 安全与收尾
- [ ] 4.1 预算/频率上限、武装默认未武装（可选持久）
- [ ] 4.2 真链端到端：入队 → 武装 → dry-run → 真跑（面板可见结果）
- [ ] 4.3 README（部署两个单元）、wiki/serve.md + batch.md、CHANGELOG、方案包迁移

---

## review14 调整（开工前必须落实）

- [ ] 0.1 **武装的第二因素**：执行器启动打印一次性 arm token（同时写入仅 `nft` 用户可读的文件，重启轮换）；`POST /api/queue/arm` 必须回填该 token；武装默认 **12 小时自动解除**
- [ ] 0.2 **任务携带审计快照**：`codeHash`、`auditedAt`、`grade`、`quality`、入队时 `mintPriceWei` 与 `capPerWallet`；执行器认领时若 `auditedAt` 超过 30 分钟先复审；**自动化路径下缺 `codeHash` 不允许静默跳过门 1**（认领时补算或拒绝该任务）
- [ ] 0.3 **账本是单一真相**：队列 `result` 只是 `.batch-state.json` 的视图（从账本条目派生）；面板「重试」仅对账本允许重试的状态开放（`SKIPPED`/`REJECTED`/开售期内 `REVERTED`）
- [ ] 0.4 补充：认领提前到 `startAt − 2h`（进入等待/复审流程）；`cancel` 允许作用于 `claimed` 且未签名的任务（执行器在 T-refresh 读取消标记）；面板显示执行器心跳（最近一次 `running` 写回时间）；`--executor --dry-run` 作为正式 flag

## B4 接口约束（现在就定，B5 直接受益）

- [ ] 0.5 任务模型：**一个队列任务 = 一个 `TargetJob`**，钱包通道由协调器分配
- [ ] 0.6 `localPublicSnipe` 拆成「准备（签名+门 1/2/3）」与「发送」两步，协调器调度发送；B5 只是把任务来源从配置文件换成队列目录
