# 任务清单: B5 执行队列 + 面板按钮 + 独立执行器

目录: `helloagents/plan/202609200944_executor-b5/`

---

## 1. 队列数据层
- [√] 1.1 `src/executor/queue.ts`：enqueue/claimNext（rename 原子认领、只认 `startAt-2h` 窗口内的任务）/complete/fail/cancel（queued 直接取消、claimed 置 cancelRequested）/reclaimStale（租约过期回收、attempts 上限）/listJobs + 输入校验 + arm（`publishArmToken` 只落哈希、`setArmed` 需回填 token、12h 过期）
- [√] 1.2 `tests/queue.cjs`（6 用例）

## 2. serve（无密钥）
- [√] 2.1 API：POST/GET /api/queue、/api/queue/cancel、/api/queue/arm|disarm（沿用 JSON+同源守卫；GET 返回 jobs+armed）
- [√] 2.2 面板：`执行队列` tab + 武装输入框 + 行内/收藏批量入队按钮 + 取消/刷新（服务端嵌入 `window.__QUEUE__`，前端只请求 serve）
- [√] 2.3 `tests/serve.cjs` 队列端点用例（入队/非法链 400/列表不武装/错误 token 403/正确 token 200/取消）

## 3. 执行器
- [√] 3.1 CLI `--executor`（`.env.executor`/`EXECUTOR_ENV_FILE`、必须有私钥的反向断言）+ `.env.executor.example` + `deploy/nft-executor.service`
- [√] 3.2 循环：reclaim → arm 检查 → claim → `jobToRawConfig` + `TargetSource` → 复用 runBatch（含三道门/burst/账本）→ 结果**从账本派生**写回；`--once`/`--interval-ms`/心跳文件；`--dry-run` 只读预演不消费任务
- [√] 3.3 进程级钱包锁（复用既有实现）；`deploy/nft-executor.service` + `.env.executor.example`（不监听端口）
- [√] 3.4 `tests/executor.cjs`（密钥断言、jobToRawConfig、needsAudit、结果从账本派生）+ 面板队列面断言（共 180 用例）

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

## review17 修复（B5 上线前）

- [√] `maxPriceEth: "current"` 在执行器侧解析（`resolveMaxPriceEth` + 写回任务）+ 用例证明 `parseEther("current")` 会抛错
- [√] 认领按开售时间排序、窗口 45 分钟、租约 30 分钟
- [√] 执行期间 30 秒心跳 + 续租（`setInterval` + `finally` 清理）
- [√] 取消在签名前生效（`shouldAbort` → local-mint）
- [√] dry-run 不清武装、账本预检标 skipped、`BURST_*` 注入、入队 10/h 限流

## B4 接口约束（现在就定，B5 直接受益）

- [ ] 0.5 任务模型：**一个队列任务 = 一个 `TargetJob`**，钱包通道由协调器分配
- [ ] 0.6 `localPublicSnipe` 拆成「准备（签名+门 1/2/3）」与「发送」两步，协调器调度发送；B5 只是把任务来源从配置文件换成队列目录


## P1.1 入队预览（review18 排期，第 4 步）

- [√] `preview.ts` + `/api/queue/preview` + 面板预览后入队（208 用例）
- [ ] P1.2 钱包视图（执行器发布余额/预留/nonce 快照 + 面板表格）
- [ ] P1.3 白名单资格标注（WALLET_ADDRESSES + `--check-allowlist`，30 分钟缓存）
