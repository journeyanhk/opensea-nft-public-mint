# Changelog

本文件记录项目所有重要变更。
格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/),
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新增
- 数量策略：`FREE_MAX_QUANTITY`（默认 5，0 关闭）——**免费 drop 取 `min(per-wallet cap, 该值)`，收费 drop 固定 1 个**；判定在 T-refresh 读到最新 plan 之后（`src/quantity.ts` 纯函数），数量变化即用新计划重建 calldata，日志打印 `quantity policy: …`；`BatchConfig.freeMaxQuantity` 支持配置/环境变量覆盖，schedule 行显示 `free max N`
- 日志修正：`lane busy` 只在真的等待通道（`waitedMs > 30`）时提示，单纯因认领晚而晚发改为 `firing +Xms after the open (claimed late)`；RPC 失败告警使用 `maskRpc` 脱敏（原会把 Alchemy key 打进 journald）- M9/B5（第四阶段）面板队列接线：`执行队列` tab（服务端嵌入 `window.__QUEUE__` 快照：jobs/armed/heartbeat）与武装输入框（填执行器 token）、行内「加入执行队列」与「收藏加入执行队列」批量按钮、任务取消与刷新；执行器在快照缺失或超过 30 分钟时**先复审并锁定 codeHash**（`needsAudit`），锁定不到就拒绝执行——自动化路径不再可能静默跳过门 1；`updateJob` 支持认领后补写快照
- M9/B5（第三阶段）执行器：`src/executor/run.ts`（私钥反向断言、启动打印并只落哈希 arm token、reclaim→arm→claim→复用 runBatch(assumeYes+队列 TargetSource)→结果从账本派生写回、心跳文件、`--once/--interval-ms/--queue-dir/--dry-run`）；`assumeYes` 选项；`.env.executor.example` 与 `deploy/nft-executor.service`（不监听端口）
- M9/B5（第二阶段）serve 队列 API：`POST/GET /api/queue`（入队校验 + jobs+armed 列表）、`/api/queue/cancel`、`/api/queue/arm|disarm`（arm 必须回填执行器打印的 token，否则 403）；沿用既有 JSON+同源守卫
- M9/B5（第一阶段）执行队列数据层：`src/executor/queue.ts`（磁盘队列 + rename 原子认领 + 租约/attempts 回收 + queued/claimed 两种取消语义 + 列表视图）、**arm token 第二因素**（执行器只落哈希并打印 token，武装必须回填、默认 12 小时过期）、任务携带审计快照字段（codeHash/auditedAt/grade/quality/mintPriceWei/capPerWallet）；6 个用例
- M8/B4 `TargetSource`：`src/target-source.ts`（`fileTargetSource` / `watchTargetSource`，合并沿用 `mergeRawConfigs` 的 slug 去重；缺失 watch 文件容忍并只提示一次），runner 改为经接口读取，B5 队列可直接新增实现
- M8/B4 `--parallel`：目标循环抽取为 `executeJob`（每目标完整流程：审计等待→burst 门→准备→通道获取→发送/爆发→回执→账本→summary），串行与并行跑同一份代码；`--parallel [N]` / `parallel`/`parallelLimit` 配置，并发上限默认 = 钱包数；`TargetJob` 状态机与 `beforeSend` 通道钩子在前几轮已就位
- M8/B4 收尾增量：`src/target-job.ts`（JobState 状态机 + `createJobs`/`advance`/`jobsToPrepare`，为 `--parallel` 与 B5 执行器共用）；runner 的余额校验改为**每目标最坏预留驱动**（`reserve` 幂等、`--watch` 合并先 claim、差额提示与周期重试）；schedule 阶段用 `orderJobs` 打印同钱包 <5s 冲突
- M8/B4（第一增量）协调器内核：`src/batch-coordinator.ts`（钱包通道独占/租约/过期回收、最坏预算 `planReservation`、`orderJobs` 排序与同钱包冲突窗口）与 `src/wallet-lock.ts`（跨进程钱包锁：OS 端口互斥 + pid/token 文件，只认 ESRCH 回收）
- M8/B3 burst：`src/burst.ts`（nonce 计划/门控/结果聚合/提前量校准）+ `local-mint` 连发路径（T-lead 首发、spacing 连发、逐钱包聚合、gas 全量入账）+ `batch-config.burst` 与 CLI `--burst-count/--burst-spacing-ms/--burst-lead-ms/--allow-overshoot/--force-clock`；账本新增 `txHashes`
- M8/B2 执行三道门 + dry-run：`src/gates.ts`（签名复核/calldata 解码/模拟分类/codeHash）、审计记录合约字节码哈希并经 `--export` 落 targets.json、`local-mint` 在签名前后 fail-closed 检查、`--dry-run` 全流程演练不广播不写账本
- M8/B1 回执核数量：`src/receipts.ts`（ERC-721/1155 日志解析 + `logsAvailable`）、`verdict` 四态；`SUCCESS` 现在是「真的到账」，新增 `PARTIAL`/`NO_MINT` 终态（绝不重发）；账本 `mintedCount/tokenIds/gasBurnedWei`；回填按实际到账摊成本；面板执行列 `SUCCESS ×N`；`waitForReceipt` 返回 logs 与 effectiveGasPrice
- M7/C 收藏与筛选保持：星标 → `.favorites.json`（原子写）+ `GET/POST /api/favorites` + `?format=jsonl` 分析导出；收藏写入**信号快照**（人工确认过的标注数据，日后与账本/回填关联）；tab「全部/收藏」与「已不在板面」分区；明细可改观察/准备/放弃与备注；一键导出 `targets.json`（接批量执行）与 `favorites.jsonl`；`--export-favorites` CLI；筛选/排序/tab 持久化到 URL hash（`复制筛选链接`），静态页回退 localStorage 并提示
- M7/A2 保守估值与流动性：新增 `src/scan/valuation.ts`（买家中位数等权、lowerQuartile×0.8 折扣、`min(floor, 下四分位×0.8, topOffer)`、地板偏离标记、证据门槛 ≥3 笔/≥2 买家/近 6h）；面板流动性标签（未开售行不给地板与利润暗示）；创作者维度 `withSales` 有界加成
- M7/A3+A4 铸造结构与聪明铸造者：`aggregateMints` 新增 `maxTxTokens`（按 `transactionHash` 归组）、`payerDiffers`、`topMinters`；新增 `src/scan/smart-minters.ts`（售罄 drop 的吃满/重复铸造地址自动进入 `.smart-minters.json`，≥2 次合格）与 `AuditResult.smartMinters`；面板加「批量痕迹」徽标（单笔 ≥10 个）+ Q 分惩罚 `batch-mint`、明细「铸造结构」行、参与维度 `smartMinters` 加成
- M7/A1 OpenSea 日历第二信息源：新增 `src/scan/calendar.ts`（`urql_transport` 解析 + 固定 UA/跟随 307/15s 超时 + fail-loud + 金丝雀）与 `refreshCalendar`（按 `CALENDAR_INTERVAL_MIN` 节流，失败沿用旧快照）；upcoming 的 slug/名称/合约/开售时间/地板/认证/禁用/stages 落 `ContractEntry.calendar` 与 `sources`；面板新增「日历/未认证/平台禁用」徽标与明细、`schedule mismatch`；`classifyPhase` 允许"未来开售但缺链上事实"判为 upcoming。真链验证：一次抓取解析出 7 条（robinhood 3 / ethereum 3 / base 1），1.9s
- M5b 社交、创作者历史与 Q 分：`--refresh-targets` 额外读取 `owner()` 与 **无需 key** 的 `collections/<slug>`（缩略图、X/Discord/官网、创建日期、safelist），已读但无链接的合集记为「已知为空」不再重试；面板名称列加缩略图（仅 https 且域名属 `seadn.io`/`opensea.io`）、展开明细显示社交与**创作者历史**（按 `owner` 聚合 drop 数/售罄率/平均 24h 速度/二级成交，叠加账本与回填的「自有数据」）
- 新增 `src/scan/quality.ts`（纯函数）：**Q 分** 0–100 = 需求 30 + 真实参与 20 + 创作者 20 + 社交身份 15 + 结构 15；未知维度不计分只降 `confidence`，惩罚项（陈旧/集中度高/无社交）独立输出；面板新增「Q 分（置信度）」列与筛选（≥40/≥60/≥80），预设升级为「免费 · A/B · Q≥60 · 未开售」
- X 粉丝数 opt-in：`ENABLE_X_METRICS=1` 时经 `api.fxtwitter.com` 抓取并缓存 24 小时，失败静默（写入 `.env.example` 与 HELP）
- 面板渲染防御：`quality`/`social` 缺失时按空值渲染，行结构来自旧调度器快照也不会 500
- M6 面板美化（零依赖，参考 demo.qqq.bot 的 Tailwind v4 + `--cladd-*` 设计语言）：内联 CSS 重写为令牌驱动（多级灰、outline、primary、语义色、圆角），`prefers-color-scheme` 自动深/浅色；摘要卡（各阶段数量/免费/队列中/最近开售倒计时）；粘性表头与粘性「名称」列、斑马纹、行悬停；等级/阶段/免费用 pill 徽标，已铸进度条，速度与净值色阶；20 列压缩为 13 核心列 + 行点击展开明细（阶段拆分/备注/slug/owner/执行/24-72时净值/等级轨迹）；移动端卡片化
- 面板全中文化：表头、筛选器、预设按钮、状态条、隐藏计数、阶段取值（未开售/新开售/在售/陈旧/售罄/已结束/待复审）；名称、slug、合约地址、链 key、txHash 保持原文；CLI 仍为英文
- M5a 面板基础事实与需求信号：审计记录写入名称/owner/价格/每钱包上限/结束时间/供应与已铸/15m 与 1h 铸造量/独立地址/集中度/阶段数；面板新增对应列、**FREE** 徽标、窗口倒计时、已铸进度、24h 速度（审计差分，不足回退 1h 估算并标注）与售罄预计、陈旧标记、OpenStreet 链接与预设按钮 `FREE · A/B · fresh`
- 复审策略扩展：开售 72 小时内（含已开售）的目标每 30 分钟复审一次（`REAUDIT_OPENED_HOURS`），候选按"积压 > 最久未审的已开售 > 新发现"排序；`/api/rows` 支持 `?stale=0|1` 过滤
- 陈旧判定（纯函数）：开售 >24h 且 已铸 <10% 且 24h 铸造 < max(5, 0.1%×supply)；面板默认隐藏并显示隐藏计数
- M4a 数据侧服务化：`--serve` 常驻调度（启动即扫、按 `SCAN_INTERVAL_MIN` 定时、互斥 tick）+ 内置 `http` 看板（`/`、`/api/status`、`/api/rows`、`/api/scan`、`/healthz`），零新依赖
- 私钥隔离（fail-closed）：`--serve` 只加载 `.env.serve` 并断言环境无 `PRIVATE_KEY(S)`，否则拒绝启动（此前入口会无条件加载 `.env`）
- 公网安全：默认绑 `127.0.0.1`；POST 强制 JSON content-type + Origin 同源；`/api/status` 对 RPC URL 与绝对路径脱敏；`/api/scan` 5 秒节流
- 部署文件：`deploy/nft-serve.service`（低权限 + systemd 加固）、`deploy/Caddyfile.example`（自动 HTTPS + basic_auth + 安全头）、`.env.serve.example`
- M3b 静态看板：`--report <out.html>`（可单独用，也可接在 `--scan` 后）从 `.scan-state.json` + `.scan-history.jsonl` + `.batch-state.json`（可选 `.audit-cache/`）生成单文件 HTML：开售时间排序、等级徽标、剩余/预计、分阶段铸造、变更与风险标注、执行结果与浏览器交易链接、等级变化轨迹；支持筛选/排序/搜索与勾选生成短名单和审计导出命令；无 server、无外部资源、全字段转义
- audit 模块导出 `readCachedScan()` 供看板离线读取缓存（不发起网络请求）
- M3a 批量热加载：`--batch <file> --watch [file...] --watch-interval <秒>` 定期重读配置，新目标经校验与逐目标余额预检后自动入队（按开售时间排序），消失的目标移出队列
- M3a 执行账本 `.batch-state.json`：广播前写 PENDING、结果回填；`txHash` 非空或 SUCCESS/REVERTED/TIMEOUT 一律跳过，SKIPPED/REJECTED 允许重试；`--no-ledger` 关闭，`--retry-pending` 重发 PENDING
- 导出改为临时文件 + rename 原子写，避免 watch 读到半写配置
- `--scan` 发现器（M2，只读）：监听 SeaDrop 单例的 `PublicDropUpdated` 与 `SeaDropMint`（topic0 OR，`topic1` 去重合约），每链 JSON 游标（只前进到 `latest − 64`，确认延迟），候选过滤（`buildLocalMintPlan` + `getMintStats` 排除售罄/已结束/超 horizon），`--limit` 封顶单次审计数，`--grade` 过滤后复用审计导出
- 扫描状态与快照：`.scan-state.json`（原子写：临时文件 + rename，损坏回退空状态）与 `.scan-history.jsonl`（每次审计一行），均无原生依赖并已 gitignore
- Arc 限流适配：Arc 扫描串行（`SCAN_CONCURRENCY.arc = 1`），限流错误退避上限 15s；审计支持分数天回看（scan 默认 0.5 天）与 `maxRetries` 透传
- `--audit` 目标审计（只读）：链上两套余量（上界 / 按近期铸造速率的实测投影）各自分级，SeaDrop 单例 `SeaDropMint` 分阶段铸造曲线（铸出/独立地址/Top 集中度），`PublicDropUpdated` 语义变更史，开售前 1 小时改价/改期告警，A/B/C/D 综合等级；`--export` 产出经 `loadBatchConfig` 校验的 `targets.<chain>.json`
- 批量前置审计（M1.5）：`auditBeforeMs`（默认 30 分钟）在开售前自动复检，命中 `auditSkipGrades`（默认 C）则跳过该目标；审计失败只告警不阻断
- SeaDrop 事件扫描原语（窗口分片 + 重试退避 + `.audit-cache` JSON 缓存），无原生依赖；`tests/fixtures/seadropmint-arc.json` 为真实链上日志
- Arc 链支持（chainId 5042，RPC `https://rpc.mainnet.arc.io`，浏览器 `https://explorer.arc.io`，原生 gas 为 USDC/18 位；SeaDrop 1.0 单例同地址）
- 每链 gas 默认值 `ChainProfile.gas`：ethereum 80/5、base 2/0.05、robinhood 2/0.05、arc 40/0；`.env` 的 `MAX_FEE_PER_GAS`/`MAX_PRIORITY_FEE` 留空时生效
- 批量模式广播前 base fee 预检：`maxFeePerGas` 低于链上 `baseFeePerGas` 时启动即报错并给出建议值，不再等到开售被节点拒收
- 向导路径也执行供应量检查（原先仅批量模式），已售罄阶段在签名前直接 SKIPPED
- 公售供应量检查：`fetchMintStats` 读取 NFT 合约的 `getMintStats`（SeaDrop 单例无此方法）；T-refresh 时全局售罄则该目标 SKIPPED，单钱包 `已铸 + quantity` 超过 `maxTotalMintableByWallet` 则剔除该钱包，合约不响应时不阻塞
- 批量日程（BATCH SCHEDULE）每行显示目标的 `已铸/上限`，剩余为 0 时标红 `SOLD OUT`
- 批量模式 `--batch <file>`：从 `targets.json` 读取多个目标，按开售时间升序无人值守依次执行公售 mint（余额预检、单次确认、汇总表、`onFailure` continue/stop）
- `targets.json` 配置：链、目标列表（slug/链接/合约地址、quantity、maxPriceEth、startAt），可选 `rpcs`/`gas`/`walletSource`/`refreshBeforeMs`/`onFailure` 覆盖
- `src/batch-config.ts`：目标解析、链一致性校验、数量 clamp 到链上单钱包上限、价格上限换算、按开售时间排序
- `src/batch-runner.ts`：RPC 选择与 chainId 校验、余额预检、单次确认、串行执行与汇总
- `tests/batch-config.cjs`：clampQuantity / computeMaxValueWei / sortTargetsByStart / resolveGas 单测

### 变更
- gas 默认值由写死的 `chainKey === "ethereum" ? 80 : 2` 改为读取 `ChainProfile.gas`；`.env.example` 中 `MAX_FEE_PER_GAS`/`MAX_PRIORITY_FEE` 改为注释示例，新装默认走链配置
- `local-mint.localPublicSnipe` 签名推迟到 T-refresh（`refreshBeforeMs`，默认批量模式 3 秒）：重读 `getPublicDrop` 与费用接收人，开售时间被推迟则重锚，总价超过 `maxValueWei` 则目标 SKIPPED；返回值由 `void` 改为 `Promise<SnipeResult[]>`
- `wizard.promptKeys` 导出以复用隐藏输入流程（无逻辑改动）
- 文档：README 增加批量模式说明；wiki 新增 batch 模块文档并更新 local-mint/arch/overview；测试命令修正为 `node --test tests/*.cjs`
- 全部越南语文案翻译为简体中文（CLI 界面、错误提示、README、安装脚本、.env 注释），不改变任何功能与时区语义
- CLI 界面文案由中文翻译为英语（README 等文档保持中文）
- 时区语义由越南时间 UTC+7 切换为 UTC+8（展示与输入均按 UTC+8；`time-format.ts` 符号重命名为 toUtc8Time/utc8TimeToDate）

### 新增
- M3c 回填与反馈闭环：`--backfill [--ledger file] [--backfill-after 24,72] [--backfill-file file]` 对账本中 SUCCESS 的目标结算 +24h/+72h 成本（链上 `tx.value + gasUsed × effectiveGasPrice`）与 OpenSea 地板价（有 key 时），净值写入 `.backfill.jsonl`；幂等、可注入网络实现、无 key 只降级
- 看板：新增 `24h net / 72h net` 两列（读取 `.backfill.jsonl`，`--backfill-file` 可覆盖）、每 5 分钟自动刷新

### 修复
- 执行器快照锁定不再被无关故障拖垮：`auditTarget` 失败时回退到 **链上只读快照**（`chainOnlySnapshot`：`getCode` + SeaDrop 计划，不依赖 OpenSea），两者都失败时把底层原因合并写进任务 `error`，日志中的 RPC 用 `maskRpc` 脱敏；线上症状是公共 RPC 返回 HTML 导致 JSON 解析报错- review17（B5 上线前）：① **面板入队的 `maxPriceEth: "current"` 在执行器侧从不解析**，`parseEther("current")` 会让每个队列任务 100% 失败——现在认领时按审计快照解析成具体上限、写回任务文件（`resolveMaxPriceEth`），解析不到就拒绝执行；② 认领顺序改为**开售时间优先**（原按入队时间，早入队的远期任务会挡住临近任务），窗口 2h→45min、租约 15→30min；③ 执行期间每 30 秒**刷新心跳与续租**（原 `runBatch` 运行 30–120 分钟期间心跳停更、租约过期会被回收）；④ **取消标记在签名前生效**（`shouldAbort` 贯穿 runner → local-mint，拿到新 plan 后、签名前检查）；⑤ `--dry-run` 不再清除正在运行执行器的武装状态；⑥ 认领时先查账本，终态条目直接标 `skipped`；⑦ `.env.executor` 的 `BURST_COUNT/BURST_ALLOW_OVERSHOOT` 可为队列任务开启 burst；⑧ 入队限流 10/h- 队列目录里的非任务 JSON（`ARMED.json`/`executor-heartbeat.json` 等）被 `listJobs` 当成任务，排序时 `createdAt` 为 undefined 触发 `localeCompare` 崩溃（serve 页面与 `/api/queue` 报 500）：① 增加 `isJob` 形状判别，凡不具备 `id/createdAt/status/contract` 的文件一律忽略（`listJobs`/`claimNext`/`nextEligible`/`reclaimStale`/`cancelJob`/`updateJob` 全部改走判别）；② 基础设施文件改名 `_armed.json`/`_heartbeat.json`（旧名仍可读，向后兼容）；③ 排序空值兜底；新增回归用例（含损坏 JSON 与无关文件）
- review16（B4 关键接线缺失）：`--parallel` 此前从未传 `beforeSend`，通道协调器在 runner 里零调用，并行时两个共享钱包的任务会读到同一个 pending nonce 各自广播。现已：① runner 在 `localPublicSnipe` 调用中传入 `beforeSend`（`acquireLanes` 整组获取/半拿回滚/失败重试 + 10s 续租 + 释放；等待超时打印晚发毫秒；开售已结束则拒绝发送）；② `local-mint` 在拿到通道后**重读 nonce 并按需重签 + 重跑门 2**；③ `TargetJob` 状态机接入日志（prepare/lane/receipt/done|failed）；④ 并行日志改为诚实措辞（发送按钱包串行），钱包锁占用提示写明「另一个 batch 或执行器正在使用该钱包」- review15（B4 首增量）：① 通道租约加 `renew`（等待回执期间续租，`expire` 只回收崩溃）；② 预留改为按任务累计（`reserve/unreserve/reservedTotal`，可带上限与缺口差额，`--watch` 合并不再覆盖）；③ 钱包锁 `EADDRINUSE` 时区分「无关服务占用」（顺延端口）与「另一实例持锁」（按 pid 报占用）；④ burst nonce 空洞自动补洞（同 nonce 0 值自转账，成功即清除标记）；⑤ `local-mint` 新增 `beforeSend` 钩子（准备不占通道、发送才占）与批量启动时的进程级钱包锁
- review14（B3）：① `calibrateLead` 改为**观测秒跳变**估时钟偏差（原公式用秒级截断的时间戳，天然 +0–1000ms 正偏，约一半概率把 burst 随机降级；现精度约 ±100ms，观测不到时标 unknown 且不拒绝）；② `--allow-overshoot` 且付费时余额预留计入 `value × count`（原先只乘 gas，付费项目会超支）；③ burst 检测最低 nonce 空洞并打印 **nonce gap** 警告、写入账本 `nonceGap`
- dry-run 会写 PENDING 账本（`batch-runner.ts` 的 PENDING 与 audit-SKIPPED 两处未受保护），导致下一次真实运行报「already handled per the ledger」而拒绝发送：三处写入统一收敛到 `shouldWriteLedger(useLedger, dryRun)`，并加源码不变式测试（recordEntry 数量必须等于守卫数量）；受影响的运行用 `--retry-pending` 恢复
- Gate 1 未钉 codeHash 时打印 `· Gate 1 skipped`（原为静默跳过，容易被误读成"通过"）；README 补充取值与三条门的日志判读
- review13（B1/B2 部署前）：① Gate 3 改为开售后才跑且并行（开售前只会 NotActive，串行会挤掉 T-0 预算），`refreshBeforeMs` 默认 3s→5s；② SeaDrop revert 改按**选择器**解码（文本匹配永不命中自定义错误；`NotActive` 同时支持 `()` 与 `(uint256,uint256,uint256)` 两种元数）；③ `--dry-run` 下余额不足降级为警告；④ `POST /api/favorites` 增加链白名单、地址正则、note/slug 长度与 snapshot 体积校验
- 收藏星标点击 400：行模板漏发 `data-contract`，客户端 `row.dataset.contract` 为 undefined 被 `JSON.stringify` 丢弃，服务端按「缺合约」拒绝（备注/标记编辑同一路径）；补上属性并加断言 + 浏览器取 dataset 的端到端校验
- review12（阶段 A 部署前）：① `refreshCalendar` 改为只保留本次扫描配置的链（原按「已注册链」过滤，Ethereum/Base 条目会长期占着状态且永远不审计），金丝雀基线同样按配置链计算；② 日历新建条目置 `pendingAudit=true`（原状态既无事件又无 `publicStart`，不在任何候选种子列表里，永远不会被审计）；③ 日历新增 `publicStartTime`（最后阶段＝公售猜测），面板开售回退与 `schedule mismatch` 只与它比较（最早阶段通常只是预售波次），明细标注「最早为预售阶段」；④ `ScanState.calendar.warnings` 持久化并经 `/api/status` 暴露
- review11 四项（M5b 运营与评分边界）：
  1) **OpenSea 限速与 429**：新增共享令牌桶 `RateLimiter`（`OPENSEA_RPS`，默认 2 req/s）与 `limitedFetch`（429 读 `retry-after` 退避重试一次、其余非 2xx 计 `rateLimited` 并在结尾提示；所有请求 15s 超时、X 10s），修掉"900+ 合约迁移大面积静默失败、反复重跑"的问题
  2) **状态并发写**：刷新改为字段级合并写（`saveStateMerged`），不再整文件覆盖；`--serve` 每轮用 `REFRESH_PER_TICK`（默认 20）自行消化积压，首次迁移无需停服
  3) **创作者评分自我包含**：`creatorStatsFor` 评分时排除目标自身，`dropCount=0`（没有其它 drop）返回 null 让维度退出，消除"热门项目靠自己热度拿创作者分"的循环论证与单 drop 的凭空 0.41
  4) **秒空标签**：新增 `instant-sellout` 惩罚/徽标（免费 + 预售吃掉 ≥40% 供应 + 独立地址 ≥1000 + 每钱包 ≥5），名称列红色标注、筛选可排除、预设默认排除
- 需求维度回退：未开售且无速度时用**预售已吃掉的比例**作代理（吃掉 50% 记满分），避免 upcoming 目标的需求维度恒为未知
- M6 面板部署后无法筛选：主行 `<tr>` 漏了脚本所选的 `class="main-row"`，`querySelectorAll("tr.main-row")` 得到 0 行，所有筛选/排序/展开都是空操作；同时短名单区块被复制了一份导致 `shortlist/copy/copyNote/commands` 四个重复 id（DevTools 报 "Duplicate form field id"）。已补上类名、删除重复区块，并新增防回归断言：渲染页面 id 唯一、主行数量与类名一致、脚本绑定所需的元素必须出现在脚本之前
- 面板链接指向 item 页：slug 此前只存在于审计历史（且升级前的行没有），无 slug 时兜底成 `opensea.io/assets/...`（会跳到 item）。现在 `ContractEntry` 持久化 `slug/name`（每个合约只解析一次），面板优先 `/collection/<slug>`，未解析时只给浏览器链接并标 `slug?`；新增 `--refresh-targets` 一次性补齐（幂等，可重复执行）
- 已结束/长期开放项目混入面板：引入 **phase 模型**（`upcoming` / `live-fresh` / `live` / `stale` / `sold-out` / `ended` / `unaudited`），由合约状态与廉价的链上事实判定；面板默认只显示 upcoming + live-fresh，其余分阶段隐藏并计数，开售超过一周且已结束的行不再渲染（状态保留供创作者历史）；`live`（开售 >24h）与 `unaudited` 不再靠陈旧规则放行
- 状态补充 `endTime/maxSupply/totalMinted`：候选过滤与审计都会顺手落盘，`--refresh-targets` 对历史遗留合约补齐；`/api/status` 增加 `openseaKey: set|unset` 便于排查 slug 为何为空
- M5a 表头错位：`<thead>` 仍是旧的 13 列而每行渲染 19 个单元格（价格/上限/已铸/15m·1h/地址数/预售/速度/陈旧/链接无表头，left/projected 表头对应错位且排序键失效）。表头改为与行一一对应的 20 列，恢复 **left** 独立列，`data-sort` 全部改为行上真实存在的属性（`mintprice/mintedpct/remaining/velocity/stale/notes/net24usd/net72usd`），并新增「表头数 = 每行单元格数」的断言
- M5a 复审挤占新发现：候选选择改为**新工作（积压 + 新发现）优先、复审填充余量**（此前复审排在前，开售 72h 内的目标会吃满 `--limit`）；开售 72h 内但连续两次审计无新增铸造的目标，复审间隔放宽到 2 小时（`quietStreak`，记录到状态文件）
- M5a 链接与过滤：OpenSea 链接在已知 slug 时用 `/collection/<slug>`（slug 随历史记录保存），否则用可落地的 `/assets/<chain>/<contract>/1`；`free only` 过滤保留价格未知的行并提示 `N price unknown`，避免过渡期误判没有免费项目
- M3c 主数据源修正：Seaport 1.6 的 `OrderFulfilled` consideration 为 **5 字段**（多 `recipient`），此前用 4 字段签名导致扫描恒为 0 条，并据此误判"Robinhood/Arc 没有二级市场"。现以**链上成交为主数据源**（实测 HoodMiners 24h 46 笔、Stock Salesman 25 笔、Catonchain 以 USDG 计价），OpenSea stats 降为补充；扫描失败显式报错、不再静默为空
- M3c 币种修正：ERC-20 计价按链上 `decimals()` 用 `parseUnits` 解析（USDG 为 6 位），不再假设 18；净值统一换算 USD（`collections` 无 key 提供 `usd_price/eth_price`，ETH/USD 由任一侧推导），无法换算时 `netUsd = null` 而不是混币种相减；看板净值列显示 USD
- 看板风险标注改为**直接读取最近一次审计的 `risks`**（审计结果现写入 `.scan-history.jsonl`，含 `risks`/`reason`/`coverage`），删除看板内重复推导：与 `--audit` 输出单一来源，局部扫描不会再误标 "top minter 80%"
- 看板短名单命令改为**内联地址**（`--audit 0x… 0x… --chain X`），不再引用不存在的 `@shortlist.<chain>.txt`
- M3a 启动条件：watch 文件缺失不再致命（视为空配置并提示 waiting），watch 模式允许空队列启动——修好"批量先于扫描器启动"这个核心场景
- M3a 账本语义：REVERTED 在公售仍开放且尝试次数 <2 时允许重试（revert 证明没铸出任何东西），避免售罄/改价类 revert 被永久封存；新增 `attempts` 计数
- M3a 长跑细节：余额不足的新目标每 5 分钟重试（充值后自动入队）；从配置移除且未执行的目标会被遗忘以便等级回升后重新入队
- 首次回填失败（Robinhood）：扫描把 `.env` 里的私有 RPC 当作日志端点，而发送最优的私有节点常常限制日志范围（Alchemy 免费档 `eth_getLogs` 仅 10 块）。新增 **RPC 角色分离** `resolveScanRpcs`：`SCAN_RPC_URL_<CHAIN>` → 公共端点 → `.env` 私有端点；`--scan`/`--audit` 的日志与区块读取改用它，批量发送仍用私有优先的 `resolveRpcsForChain`
- 首次回填失败（Arc）：密度错误正则不匹配 Arc 的 `query exceeds max results 2000, retry with the range A-B`，被当作瞬时错误重试 8 次。现在 `isRangeError` 覆盖 Arc/Alchemy 文案，`parseRangeHint` 采用节点建议范围；10 块级上限的端点直接判定不可用并**切换端点**
- 确定性错误不再重试：范围/结果类错误立即抛出并交由拆分或换端点处理，只有限流与网络错误才退避重试（此前 Arc/Robinhood 各浪费 8 轮退避）
- 发现阶段默认只订阅 `PublicDropUpdated`（能被脚本 mint 的 drop 必然发过配置事件），`SeaDropMint` 改为 `--include-mints` 显式开启：Robinhood 1 天回填从 86 窗口/5 分 14 秒降到 **9 窗口/2 分 32 秒**，Arc 2 窗口；已知合约的活动检查仍由审计阶段按合约（topic1）扫描承担
- `--scan` 默认参数在 Robinhood 上必崩：发现阶段对单例做无过滤 OR 查询，100k 块窗口（约 2.8 小时）内日志数轻易超过 RPC 的 1 万条上限。现在发现窗口降到 10k 块，并在 `scanLogs` 内实现**自适应二分**（命中 `exceeds limit` 类错误就把窗口对半拆，16 块为下限），对所有扫描调用生效
- 公开 RPC 限流：Robinhood 也改为串行扫描（此前 Arc 已是串行），发现阶段重试上限提到 8 次；`--since-days 1` 首次回填实测 5 分 14 秒（86 窗口、614 个合约），增量每轮仅 1 个窗口
- 局部扫描误导风险标签：审计触发的 0.5 天回看下，集中度标签会基于少量样本（如 5 个 token 里占 80%）。现在只有覆盖率 ≥50% 且样本 ≥50 枚时才打 "top minter" 标签，覆盖率不足时改标 `partial scan (x% of mints)`；报告的分阶段行也会标注 `(partial scan: x/y)`
- 超限候选被永久丢弃：`--limit` 之外的候选现在记入 `ContractEntry.pendingAudit`，下次运行优先消化积压再处理新发现；审计成功或判定售罄/过期时清除，失败则保留待重试
- 向导的 gas 环境变量读取统一为 trim 判空（与批量模式的 `resolveGas` 一致）：纯空白的 `MAX_FEE_PER_GAS`/`MAX_PRIORITY_FEE` 不再被 `Number(" ")` 当成 0，而是回落到链默认值
- HoodMiners / Exit Founders 实战失败：公售库存已在白名单阶段被清空（5000/5000、4444/4444），脚本仍在开售首块发送并 revert `MintQuantityExceedsMaxSupply`。现在 T-refresh 检查链上剩余量，售罄目标直接 SKIPPED，不再白付 gas
- 批量模式长等待后 keep-alive 套接字失效、T-0 广播需重付握手：T-refresh 重读后、拉 nonce 前二次调用 `warmConnections`
- 批量到达目标时配置开售已过（`targetStart=null`）但链上开售被 owner 推迟到未来，会立即发送并 revert `NotActive`：改由 `reconcileStart` 统一裁决，推迟则重新等待
- 开售时间被 owner 提前时脚本仍按旧时间等待、错过开售：现在即时对齐到新开售时间
- 新增 `.gitignore` 忽略 `targets.local.json`；README 提示不要把带 API key 的 RPC 写入会随仓库提交的 `targets.json`