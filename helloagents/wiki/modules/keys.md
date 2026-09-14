# keys 模块

## 目的
私钥加载与校验：支持 .env 明文私钥与 CLI 隐藏粘贴两种来源，保证私钥不落日志。

## 模块概述
- **职责:** walletKeysFromEnv 解析 PRIVATE_KEY/PRIVATE_KEYS，去重、补 0x 前缀；吞掉 ethers 报错避免私钥泄漏
- **状态:** ✅稳定
- **最后更新:** 2026-09-14

## 规范
### 需求: 私钥安全加载
**模块:** keys
- .env 私钥以明文存在（安全风险，仅建议小号钱包使用）
- CLI 粘贴私钥仅存于内存（askHidden 隐藏回显）
- ethers 构造 Wallet 失败时输出脱敏错误（`Private key thứ N...` → 中文）

## API接口
### 导出
- `walletKeysFromEnv(env?)` → string[]

## 数据模型
无

## 依赖
- ethers

## 变更历史
- [202609141442_zh-cn-i18n](../../history/2026-09/202609141442_zh-cn-i18n/) - 越南语文案翻译为简体中文
- [202609141521_cli-en](../../history/2026-09/202609141521_cli-en/) - CLI 文案英文化 + 时区切换为 UTC+8
