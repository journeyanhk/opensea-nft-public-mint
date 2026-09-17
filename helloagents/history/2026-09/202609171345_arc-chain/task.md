# 任务清单: Arc 链接入 + gas 按链配置 + 向导路径售罄检查

目录: `helloagents/plan/202609171345_arc-chain/`

---

## 1. 链注册表与 gas 默认值
- [√] 1.1 在 `src/chains.ts` 为 `ChainProfile` 增加 `gas: { maxFeeGwei, priorityGwei }`，为 ethereum(80/5)、base/robinhood(2/0.05) 补齐
- [√] 1.2 在 `src/chains.ts` 新增 `arc` 条目（chainId 5042、explorer https://explorer.arc.io、nativeSymbol USDC、RPC https://rpc.mainnet.arc.io、gas 40/0）
- [√] 1.3 在 `src/wizard.ts` 与 `src/batch-config.ts` 把 `chainKey === "ethereum" ? 80 : 2` 三元改为读链配置（`.env` 仍可覆盖）
- [√] 1.4 在 `src/nft-link.ts` 的 `CHAIN_ALIASES` 增加 `arc: "arc"`

## 2. 广播前 gas 预检
- [√] 2.1 在 `src/batch-runner.ts` 创建 provider 后读取最新块 `baseFeePerGas`，若 `maxFeePerGas < baseFee` 直接报错退出并给出建议值（避免开售时才被节点拒收）

## 3. 向导路径售罄检查
- [√] 3.1 在 `src/local-mint.ts` 把供应量检查抽成内部 `checkSupply(cap)`，refresh 分支与无 refresh 分支共用（无 refresh 分支同时保留价格护栏）
- [√] 3.2 确认 `refreshMs = 0` 时也应触发供应量检查与单钱包上限剔除，且结果数组仍覆盖全部钱包

## 4. 配置与文档
- [√] 4.1 `.env.example` 增加 `RPC_URL_ARC`、CHAIN 注释加 arc、gas 默认值改为按链说明（注释掉固定值）
- [√] 4.2 `README.md` 支持链表与简介加入 Arc（注明原生 gas 为 USDC）

## 5. 安全检查
- [√] 5.1 执行安全检查（新增外部 URL 无凭据、gas 预检不绕过上限、只读调用不触碰私钥）

## 6. 测试
- [√] 6.1 新增 `tests/chains.cjs`：arc 配置字段、按链 gas 默认值（清空 env 干扰）、`parseNftLink` 的 arc 链提示、`resolveRpcsForChain("arc")` 公共端点
- [√] 6.2 运行 `npm run build` 与 `node --test tests/*.cjs`，确认无回归

## 7. 知识库
- [√] 7.1 更新 `helloagents/wiki/modules/rpc.md`（gas 字段 + arc）、`overview.md`（支持链）、`project.md`（链 key）、`CHANGELOG.md`、`history/index.md`

---

## 执行总结

- 全部 15 项任务完成，`npm run build` 通过，`node --test tests/*.cjs` 25/25 通过（新增 4 个 Arc/链 gas 用例）。
- 链上核验：chainId 5042、base fee 20 gwei、feeData 40/0、SeaDrop 单例 21,081 字节、出块 0.51s、浏览器域名（Arc 官方文档）均与方案一致；方案提供的三个沙盒 drop 已失效（两个售罄、一个窗口结束），已改用日志扫描到的真实 drop 验证。
- 端到端验证（真链）：`runBatch` 对 Arc 免费 drop 走到余额预检（缺 0.01 USDC 即退出）；`MAX_FEE_PER_GAS=2` 时被 base fee 预检拦截并提示 40 gwei；`buildLocalMintPlan`/`fetchMintStats` 对 Arc 合约读取正常。
- 修复过程中的一个真实缺陷：`resolveGas` 原用 `||` 回退，会把 Arc 的 `priorityGwei: 0` 当成缺省值替换为 0.05 gwei；已改为显式空值判断并由单测锁定。
- 未验证：OpenSea 的 `arc` 链标识与 Drops API（白名单）支持（本机无法访问 api.opensea.io）；`explorer.arc.io` 本机不可达（仅影响打印链接）。

---

## 任务状态符号
- `[ ]` 待执行
- `[√]` 已完成
- `[X]` 执行失败
- `[-]` 已跳过
- `[?]` 待确认
