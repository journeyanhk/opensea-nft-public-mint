# allowlist 模块

## 目的
Allowlist / WL FCFS 路径：走 OpenSea Drops API 获取服务端签名交易，严格校验后链上模拟，通过才发送；支持轮次等待与排期刷新。

## 模块概述
- **职责:** api() 封装 Drops API；validateAllowlistTx 校验交易（chain/to/value/数量/时间窗）；checkAllowlist 校验+模拟；waitForEligibleStage 轮次等待（409/422 自动等下一轮）；runAllowlistWizard/检测 presale
- **状态:** ✅稳定
- **最后更新:** 2026-09-14

## 规范
### 需求: Allowlist 安全发送
**模块:** allowlist
- 校验: to 必须是 SeaDrop、nftContract/数量/钱包/value=mintPrice×quantity/阶段时间窗
- eth_call 模拟失败 → 不发送
- 409（未开/已关）/422（条件不满足）→ 自动等下一轮，每 ≤30s 刷新排期
- 401/429/RPC/数据错误 → 直接停止

## API接口
### 导出
- `validateAllowlistTx(raw, contract, chain, wallet, quantity)`
- `checkAllowlist(slug, address, quantity, allowPublic)`
- `hasLivePresale(drop)` / `detectPresale(slug, contract, chain)`
- `runAllowlistWizard(checkOnly, existing?)`

## 数据模型
见 data.md 交易结构与 stages 排期

## 依赖
- stage-wait / rpc-resolver / chains / seadrop-public / prompt / ethers

## 变更历史
- [202609141442_zh-cn-i18n](../../history/2026-09/202609141442_zh-cn-i18n/) - 越南语文案翻译为简体中文