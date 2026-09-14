# 任务清单: 越南语文案翻译为简体中文

目录: `helloagents/plan/202609141442_zh-cn-i18n/`

---

## 1. 翻译核心 CLI 文案（src/）
- [√] 1.1 翻译 `src/wizard.ts` 全部越南语文案，验证 why.md#需求-全量文案中文化-场景-中文界面运行
- [√] 1.2 翻译 `src/prompt.ts`、`src/index.ts`（含 HELP 文本与 askYesNo 输入识别），依赖任务1.1
- [√] 1.3 翻译 `src/local-mint.ts`、`src/rpc-blast.ts`、`src/timer.ts`、`src/connection-warmer.ts`，依赖任务1.1
- [√] 1.4 翻译 `src/allowlist.ts`、`src/stage-wait.ts`、`src/time-format.ts`，依赖任务1.1
- [√] 1.5 翻译 `src/nft-link.ts`、`src/slug-resolver.ts`、`src/rpc-resolver.ts`、`src/wallet-keys.ts`，依赖任务1.1

## 2. 翻译文档与安装脚本
- [√] 2.1 翻译 `README.md` 全部越南语内容
- [√] 2.2 翻译 `.env.example` 注释
- [√] 2.3 翻译 `install.sh`、`install.cmd` 中的越南语行

## 3. 测试同步
- [√] 3.1 更新 `tests/stage-wait.cjs` 中依赖错误文案的断言，验证 why.md#需求-全量文案中文化-场景-测试断言同步，依赖任务1.4

## 4. 安全检查
- [√] 4.1 执行安全检查（按G9: 确认 diff 仅含字符串、无敏感信息泄漏、私钥脱敏逻辑未被削弱）

## 5. 验证
- [√] 5.1 运行 `npm run build` 确认编译通过
- [√] 5.2 运行 `node --test tests/*.cjs` 确认全部测试通过（10/10）
- [√] 5.3 全库扫描越南语字符集，确认用户可见文案无残留（英文注释除外；仅 helloagents 文档中保留变更记录引用）

## 6. 文档更新
- [√] 6.1 更新 `helloagents/wiki/modules/*.md` 变更历史与 `helloagents/CHANGELOG.md`
- [√] 6.2 迁移方案包至 `helloagents/history/2026-09/` 并更新 `helloagents/history/index.md`