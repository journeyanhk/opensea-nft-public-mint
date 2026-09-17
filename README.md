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
<summary><strong>自定义 RPC 配置</strong></summary>

<br>

非必需，但私有 RPC 通常比公共节点更快。打开 `.env` 并填写所需链的 RPC：

```env
RPC_URL_ETHEREUM=
RPC_URL_BASE=https://base-mainnet.g.alchemy.com/v2/YOUR_KEY
RPC_URL_ROBINHOOD=
```

也可以在程序询问时直接粘贴 RPC URL 或 Alchemy key。

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
