# NFT Public Mint Sniper

- 参考源码来自：[morsyxbt](https://github.com/morsyxbt/nft-public-mint)
- 在 Ethereum、Base、Robinhood Chain 和 Arc 上通过 SeaDrop mint NFT 的 CLI 工具。
- **支持 mint 轮次：WL FCFS、Allowlist 和 Public。** WL FCFS/Allowlist 轮次要求钱包具备资格。
- 运行 `npm start` 并输入 collection 链接/slug 和 `OPENSEA_API_KEY` 可自动识别 mint 轮次。当前轮次未开放或不满足 mint 条件时，工具会自动等待排期中的下一轮并在开放时重新检查；发送前仍需要确认费用。
- Public 使用链上数据构造交易，并支持预签名以准点发送。WL FCFS/Allowlist 从 OpenSea API 获取 mint 数据，发送前会校验并在链上模拟。

> 建议只使用小号钱包，并只充值准备 mint 的金额。

## 视频教程

- 查看详细教程：[X / Twitter 视频](https://x.com/solotop999/status/2089201813983732190?s=20)

## 安装与运行

要求：自行安装 [Git](https://git-scm.com/downloads)。

脚本会在需要时自动安装 Node.js、安装依赖、构建、创建 `.env`、尝试获取
免费 OpenSea API key，然后启动程序。

### Windows 安装
- 打开 cmd 并输入：

```cmd
git clone https://github.com/solotop999/opensea-nft-public-mint.git && cd opensea-nft-public-mint && install.cmd
```

### Linux 安装

```bash
git clone https://github.com/solotop999/opensea-nft-public-mint.git && cd opensea-nft-public-mint && chmod +x install.sh && ./install.sh
```

## OpenSea 测试 mint 链接
- 测试链接，2027-08 过期
- Robinhood Chain
- https://opensea.io/collection/tadaaaaaa/overview
  
## 后续运行

```bash
cd opensea-nft-public-mint
npm start
```

<details>
<summary><strong>批量模式：多个目标按开售时间顺序自动执行</strong></summary>

<br>

适用场景：在同一链上按开售时间依次抢多个 collection（例如 18:00 的 A、18:30 的 B），中途不想守着终端。

1. 配置 `targets.json`（仓库根目录，可复制修改）：

```json
{
  "chain": "robinhood",
  "walletSource": "env",
  "refreshBeforeMs": 3000,
  "onFailure": "continue",
  "targets": [
    { "slug": "https://opensea.io/collection/hoodminers-rh/overview", "quantity": 1, "maxPriceEth": "0", "startAt": "auto" },
    { "slug": "https://opensea.io/collection/stock-salesman/overview", "quantity": 3, "maxPriceEth": "0.01", "startAt": "auto" }
  ]
}
```

2. 确认 `.env` 里有 `PRIVATE_KEY`/`PRIVATE_KEYS`、对应链的 RPC（如 `RPC_URL_ROBINHOOD`），以及可选的 `MAX_FEE_PER_GAS`/`MAX_PRIORITY_FEE`/`GAS_LIMIT`。

3. 在首个开售前启动（建议 tmux/screen 常驻）：

```bash
npm run build && npm start -- --batch targets.json
```

行为说明：

- `slug` 支持 OpenSea 链接、slug 或合约地址；`quantity` 会被链上单钱包上限自动截断并提示。
- `maxPriceEth` 是每个 NFT 的最高愿付价，也是防改价护栏；付费目标必须显式填写，未填会直接报错退出。总上限 = `maxPriceEth × quantity`。
- `startAt: "auto"` 使用链上公售 `startTime`，也可以用 ISO 时间覆盖。
- 启动时按 `Σ(mint value + gasLimit × maxFee)` 检查每个钱包余额，任一不足即报错退出，不发送任何交易。
- 检查通过后**只需确认一次**，随后无人值守。
- 每个目标在开售前 3 秒（`refreshBeforeMs`）重读链上价格与费用接收人，并重新校验开售时间；价格超过上限则跳过该目标，开售时间被 owner 推迟则自动重新对齐。
- 同一时刻还会检查链上剩余供应量（`getMintStats`）：已售罄则整个目标跳过，某钱包已达单钱包上限则从本次发送中剔除；BATCH SCHEDULE 会显示每个目标的 `已铸/上限`，售罄标红。白名单阶段常把热门免费项目的公售库存提前清空，这类目标建议直接走 `npm start -- --allowlist`。
- 目标按开售时间升序串行执行；`onFailure: "continue"` 时某个目标失败不影响后续目标，全部结束后输出汇总表。
- 每个目标默认在开售前 30 分钟（`auditBeforeMs`）自动做一次链上体检：预计公售无货（等级 C）就跳过并记录 `SKIPPED`，不再空等；审计本身失败只告警、不影响发送。设为 `0` 可关闭。
- `--watch` 常驻模式：每 `--watch-interval`（默认 60 秒）重读主配置与 `--watch` 后列出的文件，**新目标自动合入队列**（按开售时间排序）并执行；从配置中消失且未执行的目标会被移出队列。
- **执行账本** `.batch-state.json`：广播前先写 `PENDING`，收到结果后更新。任何已经广播过的目标（`txHash` 非空）在进程重启后都不会重发；`--no-ledger` 可关闭（不推荐），`--retry-pending` 可重发没有结果的 `PENDING`。
- 完整闭环示例：

```bash
# 窗口 1：常驻扫描（每 20 分钟一轮，A/B 级自动导出）
while true; do npm start -- --scan --chain robinhood,arc --limit 20 --export targets.scan.json --force; sleep 1200; done

# 窗口 2：常驻批量，自动吃下扫描导出的新目标
npm start -- --batch targets.json --watch targets.scan.json --watch-interval 60
```
- 限制：整批只能是一条链；两个目标同时开售时未支持并行；Allowlist/WL 阶段仍需 `npm start -- --allowlist` 单独执行。
- 注意：`targets.json` 会随仓库提交，不要把带 API key 的 RPC 写进 `rpcs`；RPC 统一放 `.env`（如 `RPC_URL_ROBINHOOD`），或改用已被 `.gitignore` 忽略的 `targets.local.json`。

</details>

<details>
<summary><strong>审计模式：排进批量之前先体检目标</strong></summary>

<br>

只读检查，不发交易、不需要私钥。回答两个问题：**公售到底还有没有货**、**项目方有没有临时改参数**。

```bash
npm run build
npm start -- --audit https://opensea.io/collection/xxx/overview --chain robinhood
npm start -- --audit 0x合约地址 0x另一个 --chain arc --wallets 0x你的地址 --export targets.arc.json --grade A,B --quantity 1 --max-price current
npm start -- --audit @watchlist.txt --chain robinhood
```

输出包含：

- **两个余量及其等级**：上界余量（链上总量 − 已铸，提前几天就能算）与预计余量（再减去"近 15 分钟铸造速率 × 距开售时间"）；两者都为正才可能是 A
- **分阶段铸造曲线**：直接读 SeaDrop 单例的 `SeaDropMint` 事件，按阶段给出铸出量、独立地址数、Top 地址集中度（白名单吃掉了多少一目了然）
- **配置变更史**：`PublicDropUpdated` 解码后的价格/开售时间/上限变更次数与最近一次时间；开售前一小时内改价会标 ⚠
- 可选增强：`.env` 里有 `OPENSEA_API_KEY` 时附加阶段名额、社交与创建日期（无 key 不影响等级判定）

`--export` 写出的 `targets.<chain>.json` 会用批量模式的同一套校验跑一遍，并打印 BATCH SCHEDULE 预览；`--grade` 决定导出哪些等级（默认 A,B）。

</details>

<details>
<summary><strong>发现模式：自动扫描链上新 drop</strong></summary>

<br>

只读。监听 SeaDrop 单例的事件（配置变更 + 铸造），自动找出候选并做一遍审计；游标保存在 `.scan-state.json`，适合定时任务每 10–30 分钟跑一次。

```bash
npm run build
npm start -- --scan --chain robinhood,arc              # 增量扫描 + 审计（默认最多 20 个）
npm start -- --scan --chain arc --export targets.arc.json --grade A,B
npm start -- --scan --chain robinhood --since-days 3 --limit 5   # 首次回看 3 天
npm start -- --scan --chain arc --no-audit            # 只看发现，不审计
npm start -- --report dashboard.html                   # 从本地状态生成静态看板（可单独用）
npm start -- --backfill                                # 结算已成功 mint 的 +24h/+72h 成本与地板价
npm start -- --refresh-targets [--limit 200]           # 补齐 slug/名称/owner/社交与链上事实（限速 + 可重复执行直到 all entries）
```

行为说明：

- 扫描 `PublicDropUpdated` 事件发现新 drop（可铸造的 drop 必然发过该事件）；`--include-mints` 可额外订阅 `SeaDropMint`，但日志量会大一个数量级
- 游标只前进到 `latest − 64` 块（确认延迟）；`eth_getLogs` 被节点以"范围/结果过多"拒绝时会采用节点建议的范围或二分，被 10 块级别的范围上限拒绝时自动换下一个端点
- 候选过滤：公售未结束、开售在 `--horizon-hours`（默认 72h）内、且不是已售罄
- 已知合约仅在"有新事件"或"开售临近且距上次审计超过 30 分钟"时重审；售罄合约在出现新事件前不再查询
- `--limit` 之外的候选写入状态文件的积压队列（`pendingAudit`），下一轮**优先审计积压**再处理新发现；审计失败会保留待重试
- 首次回填建议 Robinhood `--since-days 1`（实测约 5 分钟、86 个窗口、600+ 合约），之后每轮增量仅 1 个窗口
- 公共 RPC 限流明显，Arc 与 Robinhood 均串行扫描；配置私有 RPC（`RPC_URL_ARC`、`RPC_URL_ROBINHOOD`）会快很多
- 审计只回看 0.5 天，因此分阶段数据会标注 `(partial scan: x/y)`；集中度风险标签仅在覆盖率 ≥50% 且样本 ≥50 枚时给出
- `--backfill` 对账本中 `SUCCESS` 的目标在 +24h / +72h 结算：链上真实成本（`tx.value + gasUsed × effectiveGasPrice`）+ **Seaport 1.6 链上成交地板价**（无需 key），OpenSea stats 作为补充（有 key 时）；净值统一换算成 USD 写入 `.backfill.jsonl`，看板显示 `24h net / 72h net`。幂等，可挂在扫描循环末尾或每天跑一次
- 注意币种：Robinhood 部分收藏以 **USDG（6 位小数）**计价，而成本是 ETH——净值只有两边都能换算成 USD 时才计算，避免混币种相减。Seaport 扫描走 `SCAN_RPC_URL_<CHAIN>` / 公共端点；OpenSea stats 与地址→slug 反查需要你的长期 key（Settings → Developer）
- 面板默认视图 = **phase: upcoming + live-fresh**：只显示「未开始」和「刚开售 24h 内」的目标；`ended` / `sold-out` / `stale` / `live`（开售超过 24h）/ `unaudited`（缺事实的旧记录）默认隐藏并在状态行显示各阶段隐藏数量，可用 phase 下拉切换；开售超过一周且已结束的行会从面板移除（状态保留）
- 链接：已知 slug 时指向 `opensea.io/collection/<slug>`；未解析出 slug 的行只给区块浏览器链接并标 `slug?`，运行 `npm start -- --refresh-targets` 补齐（**slug 反查需要 `OPENSEA_API_KEY`**；每个合约只查一次并永久缓存）
- **流动性与保守估值（M7/A2）**：`src/scan/valuation.ts` 照抄 mint-desk 的护栏——24h 内 ≥3 笔不同交易 + ≥2 个不同买家 + 近 6h 有成交才算 `supported`；每个买家只贡献一个中位数（大买家无法主导）；`reference = min(地板, 下四分位×0.8, topOffer)`；地板 > 下四分位 3 倍标 `floorDivergence`。面板用回填检查点给「流动性」标签（有成交/成交样本不足/成交数据过旧），**未开售行只说"没有二级成交"、不给任何利润结论**；创作者维度加"其它 drop 有真实成交（回填 ≥3 笔）"的有界加成
- **批量痕迹（M7/A3）**：审计聚合「单笔交易最多铸出多少 token」（按 `transactionHash` 归组）与「付款人≠铸造人」笔数；单笔 ≥10 个即标 `批量痕迹`（The Obscura 的赢家是一笔 1000 个的克隆合约），徽标 + Q 分惩罚 `batch-mint`，与 `instant-sellout` 一样默认被预设排除
- **聪明铸造者集合（M7/A4-lite，自动派生）**：售罄 drop 里「吃满每钱包上限」或「铸造 ≥3 个」的地址自动进入 `.smart-minters.json`，出现 ≥2 次才算合格；审计统计目标 Top20 铸造地址中命中集合的数量（`smartMinters`）——这是开售前几小时最强的需求信号，作为参与维度加成进入 Q 分，并在明细里显示「聪明铸造者触达 N」。无需手工维护名单
- **三道门日志怎么看**：Gate 1 只在你给目标**钉了 `codeHash`** 时才运行——配置里没有就打印 `· Gate 1 skipped`（不会假装通过）；取值方式：`--audit <合约> --chain robinhood --export targets.pinned.json` 后把 `codeHash` 复制进你的 `targets.json`，或用一条命令直接算：`node -e "const {JsonRpcProvider,keccak256}=require(\"ethers\");(async()=>{const p=new JsonRpcProvider(process.env.RPC_URL_ROBINHOOD||\"https://rpc.mainnet.chain.robinhood.com\");console.log(keccak256(await p.getCode(\"<合约>\")))})()"`
- **三道门（M8/B2，review13 调整）**：Gate 3 只在**开售后**运行（开售前只会返回 NotActive，白耗 T-0 预算）且多钱包**并行**；未知选择器按 4 字节兜底；SeaDrop 自定义错误按选择器解码（`NotActive()`/`NotActive(uint256,uint256,uint256)`/`IncorrectPayment`/`MintQuantityExceedsMaxSupply`/`MintQuantityExceedsMaxMintedPerWallet`/`FeeRecipientNotAllowed` 等，选择器经 4byte 核对）；`refreshBeforeMs` 默认 3s → **5s**（重读 + 每钱包 stats + getCode + 模拟的实测预算）
- **三道门（M8/B2）**：① **合约身份锁**——审计时记录 NFT 合约字节码哈希（`codeHash`），`--export` 写进 `targets.json`，执行前重读比对，不一致**拒绝签名**；② **签名复核**——广播前 `Transaction.from` 逐字段核对并解码 `mintPublic` 断言 `nftContract/feeRecipient/minterIfNotPayer=0/quantity`，任一不符**拒绝广播**；③ **pending 模拟**——每钱包 `eth_call`：开售前 revert 属预期（NotActive），开售后 revert 或命中 payment/供应/allowlist 类错误则该钱包出局。任一环节失败都不发交易
- **并行与钱包通道（review16 修复）**：`--parallel` 的发送阶段现在**真的会取通道**——`beforeSend` 里用 `acquireLanes`（整组钱包要么全拿到、要么全放回后重试；等待期间每 10s 续租；结束时释放）把同钱包的第二个任务挡在发送之前，并打印 `waiting for the wallet lane …ms` 与 `fired +Xms after the open`；**拿到通道后会重读 pending nonce，若被别的任务消耗过则自动重签并重跑门 2**（这是并行不撞 nonce 的关键）；任务状态（prepare→lane→receipt→done/failed）写进日志，B5 执行器心跳直接复用
- **目标来源（M8/B4）**：`src/target-source.ts` 把「目标从哪来」收成一个接口（`TargetSource.read()` / `watchPaths()`）：默认是配置文件 + `--watch` 合并的文件（缺失的 watch 文件仍按空配置处理并提示一次）；B5 的执行队列会作为第二个实现接入，runner 不需要认识新格式
- **并发执行（M8/B4，`--parallel`）**：默认串行；`--parallel`（可跟数字，如 `--parallel 2`）让多个目标**同时准备与发送**——准备（重读/门/签名）不占钱包通道，发送才占，同钱包由通道串行、不同钱包天然并行；并发上限默认 = 钱包数。配置里等价写法 `"parallel": true` / `"parallelLimit": 2`。注意：`onFailure: stop` 只阻止后续目标启动，已在飞的任务会跑完；先用 `--dry-run --parallel` 彩排
- **预算与冲突（M8/B4 收尾增量）**：余额校验改由**每目标最坏预留**驱动（`planReservation`：gas×发数，overshoot 时 value×发数），`--watch` 合并的新目标先 claim 再检查，余额不足会给出 committed/short 差额并周期性重试；同一钱包多个目标开售相差 <5s 会在 schedule 打出冲突告警（第二个目标会等通道）
- **钱包通道与进程锁（M8/B4）**：发送阶段独占钱包通道（`LaneCoordinator`：租约可续、仅持有者释放、过期只用于崩溃回收；`reserve/unreserve/reservedTotal` 按任务累计最坏花费，`--watch` 合并新目标不会覆盖既有预留）；批量启动时对每个钱包取**跨进程锁**（`.locks/`，OS 端口互斥 + pid/token，kill -9 自动释放；手动 batch 与将来的执行器由此互斥）；burst 出现 nonce 空洞时自动用**同 nonce 的 0 值自转账**补洞
- **burst（M8/B3）**：多 nonce 连发——`--burst-count 2..5`、`--burst-spacing-ms`（默认 100）、`--burst-lead-ms auto|<ms>`；`auto` 由**实测校准**：p50 RTT（5 次）+ 区块时间与本地时钟偏差 + 50ms 余量。**默认关闭**（`count=1` 即单发）。护栏：`cap==1` 才允许多发（数学上只有一发能成），`cap>1`/未知必须 `--allow-overshoot`；时钟偏差 >500ms 拒绝（可 `--force-clock`）；预算按 `count × gasLimit × maxFee` 预留；结果聚合取"落到的那一发"，**所有 shot 的 gas 如实入账**（预期内回滚不是免费的），账本记 `txHashes` 全量
- **burst（M8/B3）**：多 nonce 连发——`--burst-count 2..5`、`--burst-spacing-ms`（默认 100）、`--burst-lead-ms auto|<ms>`；`auto` 为**实测校准**：p50 RTT ×5 + **观测秒跳变**得到的时钟偏差（区块时间戳是秒级截断，直接相减会带 0–1000ms 假偏差，现改为观测 `T→T+1` 边界并扣除 RTT/2 与半个出块间隔，精度约 ±100ms）+ 50ms 余量；1.5–3s 内没观测到跳变时标 `clock skew unknown`（此时**不**因时钟随机禁用 burst，只按 RTT+余量）。**默认关闭**（`count=1` 即单发）。护栏：`cap==1` 才默认允许多发（数学上只有一发能成），`cap>1` 或未知必须 `--allow-overshoot`；时钟偏差 >500ms 拒绝（可 `--force-clock`）；预算按 `count × gasLimit × maxFee` 预留，且 `--allow-overshoot` 且付费时会额外预留 `value × count`（最多 k 发都成交）；若最小 nonce 那发无回执而更高 nonce 已落地，会打印 **nonce gap** 警告（换 nonce 后再跑下一目标，否则 pending nonce 会卡住）；结果聚合取「落到的那一发」，**所有 shot 的 gas 如实入账**（预期内回滚不是免费的），账本记 `txHashes` 全量
- **dry-run 与账本**：dry-run **绝不写账本**（PENDING 也不写）——此前 PENDING 未受保护，一次 dry-run 会让下一次真实运行认为"已处理"而拒绝发送；恢复方法是 `--retry-pending`（PENDING 且无 hash 的条目被设计为可重发），现已由 `shouldWriteLedger` 单点守卫 + 源码不变式测试防回归
- **`--dry-run`（M8/B2）**：余额不足降级为**警告**（彩排的意义就是用空钱包验证流程）签名 + 三道门 + 模拟全流程，**不广播、不写账本**；部署前可零成本演练（打印将要发送的 tx hash）
- **回执核数量（M8/B1）**：`SUCCESS` = **回执真的收到 N 个 token**（解析 `Transfer(0→wallet)` / `TransferSingle|Batch`，ERC-721/1155 都支持）；status==1 但没铸到记 `NO_MINT`、只铸到一部分记 `PARTIAL`——两者与 `SUCCESS/TIMEOUT` 一样是**终态，绝不重发**（nonce 已消耗，重发就是白付一次）。账本新增 `mintedCount/tokenIds/gasBurnedWei`（tokenIds 上限 200 条并标 `tokenIdsTruncated`）；回填按**实际到账数量**摊成本与净值；面板执行列显示 `SUCCESS ×3` / `PARTIAL ×1`。端点没返回 logs 时退回按 status 判定，绝不误报「零」
- **收藏（M7/C）**：名称列星标 → `.favorites.json`（服务端原子写，`GET/POST /api/favorites`；`--report` 静态打开自动回退 localStorage 并在页面提示）。顶部 tab 切换「全部 / 收藏 (N)」，收藏 tab 另有**已不在板面**分区（目标从视图移除后收藏仍保留身份字段）。收藏时写入**信号快照**（Q 分/置信度/等级/阶段/价格/剩余/速度/聪明铸造者/惩罚项/日历收录/创作者 drop 数）——这是你人工确认过的标注数据，`--export-favorites <file.jsonl>` 或 `GET /api/favorites?format=jsonl` 导出后可与回填/账本按 `chain|contract` 关联分析「我的判断在哪些信号上最准」。明细里可改收藏标记（观察/准备/放弃）与备注，并可**导出 targets.json（收藏）**直接接批量执行
- **筛选保持（M7/C）**：等级/阶段/Q/链/免费/队列/已执行/排除秒空/搜索/tab 写进 URL hash（可分享、刷新不丢），`复制筛选链接` 一键复制；无 hash 时用本机默认值
- **OpenSea 日历第二信息源（M7/A1）**：`--scan` 每 `CALENDAR_INTERVAL_MIN`（默认 15 分钟）抓一次 `opensea.io/drops/upcoming`（固定浏览器 UA、跟随 307、15s 超时），把 upcoming 的 slug/名称/合约/开售时间/地板/认证/禁用/stages 落进状态（`sources: ["opensea-calendar"]`），面板给「日历 / 未认证 / 平台禁用」徽标与明细（地板、供应、阶段数）；链上开售时间优先，与日历相差 >1 分钟标 `schedule mismatch`（改期信号）。**解析不到数据一律报错、绝不当作「没有项目」**，并且某条链昨天有条目今天为 0 会打金丝雀告警；抓取失败沿用上一份快照。日历条目**只保留本次扫描配置的链**（`SCAN_CHAINS`，Ethereum/Base 的条目不会进状态占位）；日历新建的条目自动置 `pendingAudit`，下一轮就会被审计（否则它既没有事件也没有 publicStart，永远不会进候选）。开售时间取**最后一个阶段**（公售猜测）作为面板与改期的对比基准，最早阶段通常只是预售波次（明细会标注「最早为预售阶段」）。`/api/status` 新增 `calendar: { fetchedAt, counts, warnings }`，状态栏可看到日历抓取失败或金丝雀告警。日历 ≠ 全集：链上事件仍是主源，日历只提供提前量与质量标记
- OpenSea 请求有限速：所有调用共用一个令牌桶，`OPENSEA_RPS`（默认 2 次/秒，免费 key 建议 1–2）；遇到 429 会读 `retry-after` 退避重试一次，仍失败则计入 `rateLimited` 并在结尾提示，其它非 2xx（含 404）按「无数据」处理。`--serve` 下 `REFRESH_PER_TICK`（默认 20，0 = 关闭）让服务每轮自行补一批目标，首次迁移**无需停服**；手动 `--refresh-targets` 与 `--serve` 同时跑也安全——刷新的写入是字段级合并（`saveStateMerged`），不会覆盖并发扫描发现的合约或游标
- 面板界面（M6 起）：cladd 风扁平主题（令牌驱动的多级灰/圆角/强调色，深色浅色自适应），顶部摘要卡显示各**阶段**数量、免费数、队列中数量与最近开售倒计时；表头与「名称」列粘性固定，行点击展开明细（阶段拆分、备注/风险、社交、创作者历史、Q 分拆分、slug/owner、执行结果、24/72 时净值、等级轨迹）
- 表格 14 个核心列：名称/合约（含**缩略图**）、等级、**Q 分（含置信度）**、阶段、开售时间、价格、每钱包上限、已铸（含进度条）、剩余、15分/1时铸造、铸造地址（含集中度）、24时速度→售罄预计、链接
- 面板文案全部为中文（阶段值：未开售/新开售/在售/陈旧/售罄/已结束/待复审）；名称、slug、合约地址、链 key、txHash 与金额单位保持原文；**CLI 仍为英文**（仓库约定）
- 筛选与预设：等级、**Q 分（≥40/≥60/≥80）**、阶段、链、仅免费、仅队列中、仅已执行、**排除预计秒空**、搜索；预设按钮「免费 · A/B · Q≥60 · 未开售」一键收窄（默认勾选「排除预计秒空」）；被阶段过滤隐藏的行显示分组计数，价格未知的行在「仅免费」下保留并计数
- M5b 信号：缩略图只允许 https 且域名属于 `seadn.io` / `opensea.io`；社交（X/Discord/官网）、创建日期与 safelist 均来自 `collections/<slug>`（**无需 key**），由 `--refresh-targets` 一并补齐（已读但确实没有链接的合集记为「已知为空」，不会反复请求）
- 创作者历史按 `owner` 聚合：drop 数、售罄率、平均 24h 速度、已扫到的二级成交笔数；有账本/回填证据时叠加「自有数据」（mint 数、净值）并上调 Q 分置信度。**评分时排除目标自身**：一个项目不能靠自己的热度给自己加创作者分；只有这一个 drop 的创作者维度视为未知（不计分、降置信度），而不是给一个凭空的中间分
- Q 分 0–100 = 需求 30 + 真实参与 20 + 创作者 20 + 社交身份 15 + 结构 15 加权；**未知维度不计分、只降低 `confidence`**（列中显示的百分比），惩罚项（陈旧、集中度高、无社交、**预计秒空**）在展开明细里单独标注。未开售且无速度时，需求维度回退用**预售已吃掉的比例**（吃掉 50% 记满分）；权重是经验初值，观察后可调，集中在 `src/scan/quality.ts`
- **预计秒空**：免费 + 预售已吃掉 ≥40% 供应 + 独立地址 ≥1000 + 每钱包上限 ≥5（The Obscura 那类）时，公售剩余大概率被批量合约秒光——名称列用红色徽标标出，预设默认过滤掉，避免 Q 分把你引向一定抢不到的目标
- X 粉丝数默认关闭；`ENABLE_X_METRICS=1` 时用 `api.fxtwitter.com/<handle>` 抓取（10s 超时、24 小时缓存、失败静默），显示在展开明细的社交一行
- 陈旧规则：开售 >24h 且 已铸 <10% 且 24h 铸造 < max(5, 0.1%×supply)；开售 72 小时内的目标每 30 分钟复审，形成速度序列
- 旧历史记录没有新字段（显示为空），新审计会逐步补齐；活跃目标优先。勾选 `free only` 时价格未知的行会保留并计数（`N price unknown`）
- `--report <out.html>` 生成单文件静态看板（无 server、无外部资源、file:// 直接打开）：按开售时间排序，显示等级、剩余/预计、分阶段铸造、变更与风险标注、执行结果（含浏览器交易链接）与等级变化轨迹；支持按等级/链筛选、排序、搜索，勾选后一键复制短名单与审计/导出命令（可另行保存成 `@shortlist.<chain>.txt`）
- 建议 crontab 示例：`*/20 * * * * cd <repo> && npm start -- --scan --limit 10 >> scan.log 2>&1`

</details>

<details>
<summary><strong>自定义 RPC 配置</strong></summary>

<br>

非必需，但私有 RPC 通常比公共节点更快。打开 `.env` 并填写所需链的 RPC：

```env
RPC_URL_ETHEREUM=
RPC_URL_BASE=https://base-mainnet.g.alchemy.com/v2/YOUR_KEY
RPC_URL_ROBINHOOD=
```

也可以在程序询问时直接粘贴 RPC URL 或 Alchemy key。

> 扫描（`--scan`/`--audit`）默认优先使用公共节点做 `eth_getLogs`，因为发送交易最优的私有节点往往限制日志范围（Alchemy 免费档仅 10 块）。若你有支持宽范围的付费节点，在 `.env` 里设置 `SCAN_RPC_URL_ROBINHOOD`（或对应链）即可固定扫描端点。

### .env 中的私钥（可选）

把私钥粘贴到 `.env` 中，方便后续运行复用：

```env
PRIVATE_KEY=YOUR_PRIVATE_KEY
# 或者多个钱包：
PRIVATE_KEYS=KEY_1,KEY_2
```

运行时在私钥来源菜单中选择 **使用 .env 中的私钥**。如果两个变量都填写，
程序会全部加载并跳过重复钱包。只显示钱包地址。
你仍可选择 **在 CLI 中隐藏粘贴**，让私钥仅保存在内存中。

`.env` 中的私钥是明文；不要分享该文件。`.env` 已被 Git 忽略。
不要把助记词填入私钥变量。

### OpenSea API key（仅在使用 collection slug/链接时需要）

安装器会在首次运行时尝试自动创建 key 并保存到 `.env`。如果 OpenSea 提示
创建受限，请使用已有 key 或按下文手动操作。

获取免费 key 的最快方式：

```bash
curl -X POST https://api.opensea.io/api/v2/auth/keys
```

复制结果中的 `api_key` 值并填入 `.env`：

```env
OPENSEA_API_KEY=刚复制的KEY
```

免费 key 的有效期见结果中的 `expires_at` 字段。过期后，
创建新 key 并替换 `.env` 中的 `OPENSEA_API_KEY`。如需更高额度，
登录 OpenSea 后进入 **Settings → Developer → Get access → Create key**。

API key 仅用于将 slug 转换为合约地址。如果不想获取 key，
可直接粘贴合约地址 `0x...`；mint 过程不需要 OpenSea API。

</details>

<details>
<summary><strong>使用方法</strong></summary>

<br>

程序会依次询问：

1. 私钥 — 选择隐藏粘贴（仅保存在内存）或从 `.env` 加载。
2. 区块链和每个钱包要 mint 的 NFT 数量。
3. OpenSea 链接、slug 或 NFT 合约地址。
4. RPC、gas 费和发送时间。
5. 广播交易前的最终确认。

如果 mint 轮次尚未开始，选择 **等待 mint 开始** 并保持电脑和终端运行。
在你确认 `y` 之前不会发送任何交易。

</details>

<details>
<summary><strong>技术与安全说明</strong></summary>

<br>

- 运行 `npm start`：输入 collection 链接/slug，配置了 `OPENSEA_API_KEY` 时工具会自动检测正在进行的 Allowlist/WL FCFS 轮次。如果没有进行中的 presale，则继续链上 Public 流程和现有的 Public 等待排期。直接输入合约地址或缺少 API key 时仅支持识别 Public，并在 CLI 中有明确提示。
- Allowlist/WL FCFS 通过 OpenSea Drops API 支持 `mintSigned()` 和 `mintAllowList()`；复用已输入的钱包和数量，发送前逐个钱包确认费用。如果 API 返回 409（未开始/已关闭）或 422（不满足 mint 条件），工具会自动等待下一轮，最多每 30 秒刷新一次排期，并在开放时重新检查。可以继续到 Public。HTTP 422 也可能由余额不足/额度用尽引起；工具不会仅凭该状态码断定钱包不在白名单。认证错误、API 限流、RPC 或数据无效会停止。
- 检查钱包：`npm start -- --check-allowlist`（只需公开地址，不签名/不发送交易）。
- Mint Allowlist：`npm start -- --allowlist`。输入 collection、钱包地址、数量；检查成功后才会要求隐藏输入私钥，并在发送前确认总费用。
- Allowlist 需要 `OPENSEA_API_KEY`。API 自动选择正在进行的合格轮次；`--check-allowlist` 检查模式不等待且拒绝 Public。mint 流程在链上数据校验后可以转入 Public。未来轮次的 eligibility 无法在开放前检查。保持终端运行以等待，Ctrl+C 取消。钱包按顺序处理；找到有效交易后仍需确认费用。
- eligible 结果仅确认模拟时请求的数量。API/RPC 错误不能作为钱包不在白名单的证据。
- 实际 gas 费用为 base fee + tip；max fee 只是上限。
- 程序会检查 chain ID、余额、单钱包上限和 mint 开放时间。
- 在 CLI 中粘贴的私钥不会写入磁盘。自动保存在 `.env` 中的私钥为明文；RPC 只会收到已签名的 raw transaction。

<details>
<summary><strong>服务化部署：常驻扫描 + 公网看板</strong></summary>

<br>

把"扫描 → 回填 → 看板"做成一个常驻服务，浏览器随时可看。**服务进程不持有私钥**（`--serve` 只读 `.env.serve`，检测到私钥会拒绝启动）。

前置：一台 Linux 服务器、一个指向它的域名（Caddy 自动签发 HTTPS）、只对外放行 80/443。

```bash
# 1) 代码与依赖
git clone <repo> ~/opensea-nft-public-mint && cd ~/opensea-nft-public-mint
npm ci --ignore-scripts && npm run build

# 2) 服务环境（复制后填写 RPC 与 OpenSea key；绝不要写 PRIVATE_KEY）
cp .env.serve.example .env.serve && vi .env.serve

# 3) 先本地验证
node dist/index.js --serve &
curl -s http://127.0.0.1:8787/healthz   # {"ok":true}

# 4) systemd 托管
sudo useradd -r -m nft && sudo chown -R nft:nft ~/opensea-nft-public-mint
sudo cp deploy/nft-serve.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now nft-serve
journalctl -u nft-serve -f              # 看首轮扫描开始/结束

# 5) Caddy 反代（自动 HTTPS + basic_auth）
caddy hash-password --plaintext '你的强密码'   # 填入 deploy/Caddyfile.example
sudo cp deploy/Caddyfile.example /etc/caddy/Caddyfile && sudo systemctl reload caddy
```

**执行器不监听端口**：它是队列的消费者，和面板之间只共享 `queue/` 目录——面板写任务、执行器原子认领、结果与心跳写回。浏览器永远只请求 serve 一个地址（`/api/queue`、`/api/queue/arm`、`/api/queue/cancel`），无需知道执行器存在；系统里也不该出现第二个 HTTP 服务。

- **数量策略的边界**：链上 per-wallet 上限为 1 时，`FREE_MAX_QUANTITY=999` 也只铸 **1**（取 `min(上限, 本值)`）；**收费 drop 不受该参数影响，永远 1 个**；只有「链上报告上限为 0（SeaDrop 的不限）」才会用满本值——设成 999 意味着一笔 999 个的铸造（gas 约 1500 万），节点可能直接拒绝，建议 **5–10**。gas 上限会随数量自动放大（`gasLimitForQuantity`，每枚 150k + 60k 余量），并打印 `gas limit raised …`
- **数量策略（免费拿满 / 收费 1 个）**：`FREE_MAX_QUANTITY`（`.env.executor`，默认 5，0 关闭）。在 **T-refresh 读到最新价格之后**判定：免费 drop 取 `min(链上 per-wallet 上限, FREE_MAX_QUANTITY)`，收费 drop 固定 1 个；数量变化时会用同一份新计划**重建 calldata**，并在日志打印 `quantity policy: …`。这样临近开售改价/改上限都会按最新规则处理，而不是沿用入队时的数量
- **执行器的 RPC 必须配付费端点**：快照回退到「链上只读」（`getCode` + SeaDrop 读）时仍需要 RPC；公共端点被 Cloudflare 限流会返回 HTML，症状是 `Unexpected token` + `<!DOCTYPE` 且任务被标 `no codeHash could be pinned`。请在 `.env.executor` 设 `RPC_URL_ROBINHOOD`（Alchemy）与 `SCAN_RPC_URL_ROBINHOOD`；失败原因现在会写进任务 `error`（含底层报文），日志里的 RPC 已脱敏
- - **武装（arm token）改为固定**：token 首次生成后存 `queue/arm-token`（0600，与 `.env.executor` 同级），**重启沿用**，且未过期的武装窗口也会保留（重启不需要重新武装）；武装本身仍按 `EXECUTOR_ARM_TTL_H`（默认 12 小时）过期。换 token：`node dist/index.js --executor --rotate-arm-token`（同时解除武装）。安全性说明：能读到这个文件的人本来就能读私钥，所以放这里不降低防护，仍然挡住“只有面板密码”的远程攻击者
- 执行器与队列的运维要点：① 执行器启动日志里有 **arm token**（12 小时过期），`journalctl -u nft-executor` 的输出请勿外发；② 队列的认领顺序是**开售时间**（不是入队时间），只认领 45 分钟窗口内的任务，执行期间每 30 秒刷新心跳与租约；③ 面板入队的 `"current"` 价格会在认领时按审计快照解析成具体上限并写回任务（开售前改价会被 T-refresh 护栏拒绝）；④ 同一合约若账本已有终态条目，任务会直接标 `skipped: already handled per ledger`；⑤ 入队限流 10/h（面板密码泄露时的第二道闸）。

执行队列的用法：面板「执行队列」tab → 行内「加入执行队列」或「收藏加入执行队列」→ 把执行器启动日志里的 arm token 填进「武装」（12 小时过期）→ 执行器认领并复用完整管线（三道门/burst/账本），快照缺失或超过 30 分钟会先复审并**锁定 codeHash**，否则拒绝执行；结果从账本派生（单一真相），`--executor --dry-run` 可只读预演。

打开 `https://<你的域名>/`：顶部状态条显示扫描进度与行数，可点 **Scan now** 立即触发；表格与 `--report` 完全一致。状态条与 `/api/status` 也会显示每轮的 refresh 结果（`processed/socials/x/rate-limited/remaining`）。

首次迁移无需停服：`REFRESH_PER_TICK`（默认 20）会让服务每轮扫描后补一批目标，若干轮后自行清空积压；想更快可在另一终端手动跑 `npm start -- --refresh-targets --limit 200`（字段级合并写，不会与服务的扫描互相覆盖），但请把 `OPENSEA_RPS` 保持在你 key 的限额内。

验收要点：`journalctl` 里一轮扫描有清晰的开始/结束；页面首轮 5–10 分钟内有数据（Robinhood 1 天回填约 3–5 分钟）；`ps eww <pid>` 或 `tr '\0' '\n' < /proc/<pid>/environ | grep PRIVATE` 应无输出。

安全提示：服务只绑 `127.0.0.1:8787`，请勿把 8787 暴露到公网；basic_auth 请用强密码，必要时再叠加 fail2ban 或 IP 白名单。面板导出（写 `exports/`）在下一步 M4b 提供。

</details>

## 支持的链

| 链 | ID | 浏览器 |
|---|---:|---|
| Ethereum | 1 | etherscan.io |
| Base | 8453 | basescan.org |
| Robinhood Chain | 4663 | robinhoodchain.blockscout.com |
| Arc | 5042 | explorer.arc.io |

> Arc 的 gas 用链上原生 USDC 支付（RPC 按 18 位小数计），且 base fee 约 20 gwei——`.env` 里的 `MAX_FEE_PER_GAS` 若还是 2 会被节点拒收，批量模式会在启动时直接报错提示。

</details>

## 许可证

MIT
