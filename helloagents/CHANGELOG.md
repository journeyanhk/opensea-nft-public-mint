# Changelog

本文件记录项目所有重要变更。
格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/),
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新增
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

### 修复
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