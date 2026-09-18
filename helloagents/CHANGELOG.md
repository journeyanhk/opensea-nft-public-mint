# Changelog

本文件记录项目所有重要变更。
格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/),
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新增
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