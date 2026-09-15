# Changelog

本文件记录项目所有重要变更。
格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/),
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新增
- 批量模式 `--batch <file>`：从 `targets.json` 读取多个目标，按开售时间升序无人值守依次执行公售 mint（余额预检、单次确认、汇总表、`onFailure` continue/stop）
- `targets.json` 配置：链、目标列表（slug/链接/合约地址、quantity、maxPriceEth、startAt），可选 `rpcs`/`gas`/`walletSource`/`refreshBeforeMs`/`onFailure` 覆盖
- `src/batch-config.ts`：目标解析、链一致性校验、数量 clamp 到链上单钱包上限、价格上限换算、按开售时间排序
- `src/batch-runner.ts`：RPC 选择与 chainId 校验、余额预检、单次确认、串行执行与汇总
- `tests/batch-config.cjs`：clampQuantity / computeMaxValueWei / sortTargetsByStart / resolveGas 单测

### 变更
- `local-mint.localPublicSnipe` 签名推迟到 T-refresh（`refreshBeforeMs`，默认批量模式 3 秒）：重读 `getPublicDrop` 与费用接收人，开售时间被推迟则重锚，总价超过 `maxValueWei` 则目标 SKIPPED；返回值由 `void` 改为 `Promise<SnipeResult[]>`
- `wizard.promptKeys` 导出以复用隐藏输入流程（无逻辑改动）
- 文档：README 增加批量模式说明；wiki 新增 batch 模块文档并更新 local-mint/arch/overview；测试命令修正为 `node --test tests/*.cjs`
- 全部越南语文案翻译为简体中文（CLI 界面、错误提示、README、安装脚本、.env 注释），不改变任何功能与时区语义
- CLI 界面文案由中文翻译为英语（README 等文档保持中文）
- 时区语义由越南时间 UTC+7 切换为 UTC+8（展示与输入均按 UTC+8；`time-format.ts` 符号重命名为 toUtc8Time/utc8TimeToDate）

### 修复
- 批量模式长等待后 keep-alive 套接字失效、T-0 广播需重付握手：T-refresh 重读后、拉 nonce 前二次调用 `warmConnections`
- 批量到达目标时配置开售已过（`targetStart=null`）但链上开售被 owner 推迟到未来，会立即发送并 revert `NotActive`：改由 `reconcileStart` 统一裁决，推迟则重新等待
- 开售时间被 owner 提前时脚本仍按旧时间等待、错过开售：现在即时对齐到新开售时间
- 新增 `.gitignore` 忽略 `targets.local.json`；README 提示不要把带 API key 的 RPC 写入会随仓库提交的 `targets.json`