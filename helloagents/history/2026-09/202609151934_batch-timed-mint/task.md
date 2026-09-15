# 任务清单: 多目标顺序定时 mint（batch 模式）

目录: `helloagents/plan/202609151934_batch-timed-mint/`

---

## 1. 配置层
- [√] 1.1 新增 `targets.json`，声明 robinhood 链、`walletSource: env`、`refreshBeforeMs: 3000`、`onFailure: continue` 及两个目标（hoodminers-rh ×1 上限 0、stock-salesman ×3 上限 0.01），验证 why.md#[需求-顺序定时执行多目标]-[场景-同链两目标相隔-30-分钟]
- [√] 1.2 在 `src/batch-config.ts` 定义 `BatchTarget`/`BatchConfig` 与纯函数 `clampQuantity(qty, cap)`、`computeMaxValueWei(maxPriceEth, qty)`、`sortTargetsByStart(targets)`，验证 why.md#[需求-顺序定时执行多目标]-[场景-同链两目标相隔-30-分钟]，依赖任务1.1
- [√] 1.3 在 `src/batch-config.ts` 实现 `loadBatchConfig(path, rpcUrls)`：`parseNftLink` 解析目标、`resolveSlug` 解析 slug、校验链一致、`buildLocalMintPlan` 读公售、clamp 数量、计算价格上限、按 `startAt` 排序，验证 why.md#[需求-顺序定时执行多目标]-[场景-目标已结束或非-seadrop-公售]，依赖任务1.2

## 2. 执行单元改造
- [√] 2.1 在 `src/local-mint.ts` 新增 `SnipeResult` 类型，`localPublicSnipe` 返回值改为 `Promise<SnipeResult[]>` 并在各分支收集结果（保持向导调用兼容），验证 why.md#[需求-顺序定时执行多目标]-[场景-同链两目标相隔-30-分钟]
- [√] 2.2 在 `src/local-mint.ts` 将 `warmConnections` 前置，签名前插入"等待到 `startAt - refreshBeforeMs` → 重读 `buildLocalMintPlan` → 价格护栏 `maxValueWei`"逻辑，`refreshBeforeMs` 缺省时行为与现状一致，验证 why.md#[需求-顺序定时执行多目标]-[场景-开售前-owner-改价或改期]，依赖任务2.1
- [√] 2.3 在 `src/local-mint.ts` 实现 `startTime` 后移时的重锚等待（重读发现新开售时间则更新 `targetStart` 并再次等待，设上限防死循环），验证 why.md#[需求-顺序定时执行多目标]-[场景-开售前-owner-改价或改期]，依赖任务2.2

## 3. 编排与入口
- [√] 3.1 在 `src/wizard.ts` 将 `promptKeys` 加 `export`（仅关键字，无逻辑改动），供批量模式复用，验证 why.md#[需求-顺序定时执行多目标]-[场景-同链两目标相隔-30-分钟]
- [√] 3.2 在 `src/batch-runner.ts` 实现 `runBatch(path)`：解析 RPC（`resolveRpcsForChain` + `planRpcs`）→ 加载配置 → 取钱包（env 或 `promptKeys`）→ 余额预检（Σ value+gas）→ 打印日程 → 单次 `askYesNo` 确认 → `closePrompts`，验证 why.md#[需求-顺序定时执行多目标]-[场景-余额不足]，依赖任务1.3、3.1
- [√] 3.3 在 `src/batch-runner.ts` 实现逐目标循环（跳过已结束、调用 `localPublicSnipe`、按 `onFailure` continue/stop）与汇总表输出，验证 why.md#[需求-顺序定时执行多目标]-[场景-同链两目标相隔-30-分钟]，依赖任务2.3、3.2
- [√] 3.4 在 `src/index.ts` 新增 `--batch <file>` 分支并更新 HELP，验证 why.md#[需求-顺序定时执行多目标]-[场景-同链两目标相隔-30-分钟]，依赖任务3.3

## 4. 安全检查
- [√] 4.1 执行安全检查（按G9: 私钥仅内存/env、错误信息不泄露私钥、价格护栏不可绕过、RPC 链 ID 校验）

## 5. 文档更新
- [√] 5.1 更新 `helloagents/wiki/modules/local-mint.md`（T-3s 重读/重锚/护栏/SnipeResult）并新增 `helloagents/wiki/modules/batch.md`
- [√] 5.2 更新 `helloagents/wiki/arch.md`（架构图与 ADR-4~7 索引）、`helloagents/project.md`（如涉及）
- [√] 5.3 更新 `README.md`（`--batch` 用法、`targets.json` 示例、余额与时钟提示）
- [√] 5.4 更新 `helloagents/CHANGELOG.md`

## 6. 测试
- [√] 6.1 新增 `tests/batch-config.cjs`，对 `clampQuantity`、`computeMaxValueWei`、`sortTargetsByStart` 做纯函数断言
- [√] 6.2 运行 `npm run build` 与 `node --test tests/`，确认既有 allowlist/stage-wait 测试不回归

---

## 执行总结

- 全部 17 项任务完成，`npm run build` 通过，`node --test tests/*.cjs` 14/14 通过。
- 计划外修正：Node 24 下 `node --test tests/` 不再接受目录参数，`project.md` 测试命令改为 `node --test tests/*.cjs`。
- 额外验证：对 Robinhood 公链 RPC 跑通 `resolveRpcsForChain + planRpcs + loadBatchConfig` 的地址路径与两条错误路径（无公售、链不一致）；OpenSea API 在本机当前网络不可达，slug 解析沿用的既有 `resolveSlug` 未做联网复验。
- 未实现（计划内明确不做）：同刻开售的并行分支、跨链单批。

---

## 任务状态符号
- `[ ]` 待执行
- `[√]` 已完成
- `[X]` 执行失败
- `[-]` 已跳过
- `[?]` 待确认
