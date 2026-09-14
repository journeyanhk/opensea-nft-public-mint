# 任务清单: CLI 界面文案英文化 + 时区切换为 UTC+8

目录: `helloagents/plan/202609141521_cli-en/`

---

## 1. 翻译 CLI 文案并切换时区（src/）
- [√] 1.1 翻译 `src/wizard.ts` 全部中文文案为英语并将时间标签改为 UTC+8（含导入改名），验证 why.md#需求-CLI-全量英文化-场景-英语界面运行
- [√] 1.2 翻译 `src/prompt.ts`（含 askYesNo 移除中文输入）、`src/index.ts`（HELP 文本），依赖任务1.1
- [√] 1.3 翻译 `src/local-mint.ts`、`src/rpc-blast.ts`、`src/timer.ts`、`src/connection-warmer.ts`，依赖任务1.1
- [√] 1.4 翻译 `src/allowlist.ts`、`src/stage-wait.ts`（locale/timeZone 改为 en-US/Asia/Shanghai、GMT+8），依赖任务1.1
- [√] 1.5 翻译 `src/nft-link.ts`、`src/slug-resolver.ts`、`src/rpc-resolver.ts`、`src/wallet-keys.ts`，依赖任务1.1
- [√] 1.6 改造 `src/time-format.ts`：偏移 +8、符号重命名（UTC8_OFFSET_MS/toUtc8Time/utc8TimeToDate）、注释与错误消息英文，验证 why.md#需求-时区切换为-UTC-8-场景-UTC-8-时间显示与输入

## 2. 测试同步
- [√] 2.1 更新 `tests/stage-wait.cjs` 中依赖错误文案的断言，验证 why.md#需求-CLI-全量英文化-场景-测试断言同步，依赖任务1.4

## 3. 安全检查
- [√] 3.1 执行安全检查（按G9: 确认 diff 仅含字符串/常量、无敏感信息泄漏、私钥脱敏逻辑未被削弱）

## 4. 验证
- [√] 4.1 运行 `npm run build` 确认编译通过
- [√] 4.2 运行 `node --test tests/*.cjs` 确认全部测试通过（10/10）
- [√] 4.3 扫描 `src/` 与 `tests/` 中文残留（结果为 0）
- [√] 4.4 校验 `toUtc8Time`：13:00 UTC → 21:00 UTC+8 ✓；utc8TimeToDate("21:05") → 13:05 UTC ✓

## 5. 文档更新
- [√] 5.1 更新 `helloagents/CHANGELOG.md`、`helloagents/project.md`（时间约定）、`helloagents/wiki/arch.md`（ADR-2/ADR-3）、`helloagents/wiki/modules/*.md` 变更历史
- [√] 5.2 迁移方案包至 `helloagents/history/2026-09/` 并更新 `helloagents/history/index.md`