# 任务清单: 供应量检查（getMintStats 售罄跳过）

目录: `helloagents/plan/202609161339_supply-check/`

---

## 1. 链上读取
- [√] 1.1 在 `src/seadrop-public.ts` 新增 `MintStats` 类型与 `fetchMintStats(rpcUrlOrProvider, nftContract, minter)`，读 NFT 合约（非 SeaDrop 单例）的 `getMintStats`，不可读返回 null 不阻塞
- [√] 1.2 在 `src/batch-config.ts` 加载时读一次供应量（minter=0x0），写入 `BatchTarget.supply`，为 null 时不影响加载

## 2. 执行期护栏
- [√] 2.1 在 `src/local-mint.ts` 抽出具名纯函数 `supplyVerdict(totalMinted, maxSupply, requested)` 与 `exceedsWalletCap(minted, quantity, cap)`
- [√] 2.2 在 `src/local-mint.ts` 的 T-refresh 重读循环内加入：全局售罄 → 整目标 SKIPPED；剩余不足 → 警告；单钱包已达上限 → 从本次发送中剔除该钱包（保留原 idx），全部被剔除则 SKIPPED
- [√] 2.3 在 `src/local-mint.ts` 调整钱包遍历为"活跃钱包 + 原始 idx"结构，结果数组覆盖全部钱包（被剔除者记 SKIPPED）

## 3. 展示
- [√] 3.1 在 `src/batch-runner.ts` 的 BATCH SCHEDULE 每行追加 `已铸/上限`，剩余为 0 时标红 `SOLD OUT`

## 4. 安全检查
- [√] 4.1 执行安全检查（新增只读调用不触碰私钥；售罄/上限判定不改变发送路径的资金安全；错误信息不泄露）

## 5. 文档更新
- [√] 5.1 更新 `helloagents/wiki/modules/local-mint.md`、`helloagents/wiki/modules/batch.md`、`helloagents/wiki/data.md`、`README.md`
- [√] 5.2 更新 `helloagents/CHANGELOG.md`

## 6. 测试
- [√] 6.1 在 `tests/local-mint.cjs` 增加 `supplyVerdict`（售罄/紧张/未知上限）与 `exceedsWalletCap`（上限/不限）断言
- [√] 6.2 运行 `npm run build` 与 `node --test tests/*.cjs`，确认无回归

---

## 执行总结

- 全部 12 项任务完成，`npm run build` 通过，`node --test tests/*.cjs` 21/21 通过（新增 2 组纯函数断言）。
- 链上核验：用两笔失败交易反解合约地址后，`getMintStats` 证实 HoodMiners 5000/5000、Exit Founders 4444/4444；Exit Founders `totalSupply()`=3697 而累计铸造 4444（747 次销毁不释放额度），复盘结论成立。
- 端到端验证：`loadBatchConfig` 对两个真实合约读出 `supply` 且 `supplyVerdict` 判为 sold-out；以随机空钱包对 HoodMiners 调用 `localPublicSnipe`（`refreshBeforeMs=3000`）输出 "Sold out on-chain: 5000/5000 minted — skipping"，结果为 `SKIPPED`，未签名、未广播。
- 目标选择建议（非代码）：热门免费项目的公售常被白名单清空，优先走 `--allowlist` 或选择付费项目。

---

## 任务状态符号
- `[ ]` 待执行
- `[√]` 已完成
- `[X]` 执行失败
- `[-]` 已跳过
- `[?]` 待确认
