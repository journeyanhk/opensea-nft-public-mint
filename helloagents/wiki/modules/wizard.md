# wizard 模块

## 目的
CLI 交互向导：引导用户完成私钥、链、数量、NFT 目标、RPC、gas、时机选择与最终确认。

## 模块概述
- **职责:** 交互流程编排、输入校验（地址/时间/slug）、余额与 affordability 检查、确认后触发 localPublicSnipe
- **状态:** ✅稳定
- **最后更新:** 2026-09-14

## 规范
### 需求: 全流程交互引导
**模块:** wizard
用户在向导中依次回答：私钥来源 → 链 → 每钱包数量 → NFT 链接/slug/合约地址 → RPC → gas → 时机 → 确认。
- 时机选项：等待开售（T-0 发送）/立即发送/自定义 HH:MM（UTC+8）
- 余额检查按 `gasLimit × maxFee + mint 金额` 预占口径
- gas 预填值来自 `ChainProfile.gas`（`.env` 覆盖，空白值按未设置处理）；低于链上 base fee 时自动抬到建议值

## API接口
### 导出
- `runWizard()`：公售路径主流程
- 依赖：prompt（askChoice/askHidden/askNumber/askText/askYesNo）、time-format（toUtc8Time/utc8TimeToDate）、nft-link、slug-resolver、rpc-resolver、seadrop-public、local-mint、allowlist

## 数据模型
无独立数据模型（见 data.md 环境变量）

## 依赖
- prompt / time-format / nft-link / slug-resolver / rpc-resolver / seadrop-public / local-mint / allowlist / wallet-keys

## 变更历史
- [202609141442_zh-cn-i18n](../../history/2026-09/202609141442_zh-cn-i18n/) - 越南语文案翻译为简体中文
- [202609141521_cli-en](../../history/2026-09/202609141521_cli-en/) - CLI 文案英文化 + 时区切换为 UTC+8