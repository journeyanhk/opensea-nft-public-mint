# 变更提案: 越南语文案翻译为简体中文

## 需求背景
当前仓库 fork 自越南语版本，CLI 界面、错误提示、README、安装脚本、.env 注释、测试断言中大量使用越南语。使用者需要中文界面以便理解和操作。用户明确要求：翻译全部文案为中文，其他（功能、逻辑、时区语义）先不改动。

## 变更内容
1. 翻译 `src/` 全部越南语用户可见文案（CLI 提示、错误消息、状态输出）为简体中文
2. 翻译 README.md、.env.example、install.sh / install.cmd 中的越南语
3. 同步更新 tests/stage-wait.cjs 中依赖错误文案的断言
4. 保持英文注释、品牌名（NFT Public Mint Sniper）、技术术语（SeaDrop、RPC、gas 等）不变
5. 时区语义保持越南时间 UTC+7，仅文字翻译（如 "VN (UTC+7)" → "越南时间 (UTC+7)"）

## 影响范围
- **模块:** wizard、local-mint、allowlist、rpc、keys、prompt、timer、stage-wait、time-format、nft-link、slug-resolver、rpc-blast、connection-warmer、index
- **文件:** 19 个（src/*.ts ×14、README.md、.env.example、install.sh、install.cmd、tests/stage-wait.cjs）
- **API:** 无变更（仅字符串内容）
- **数据:** 无变更

## 核心场景

### 需求: 全量文案中文化
**模块:** wizard / local-mint / allowlist / rpc / keys
运行 CLI 时所有提示、菜单、错误、状态输出均为简体中文；README 与 .env 注释可被中文用户直接阅读。

#### 场景: 中文界面运行
用户执行 `npm start`，从 banner、私钥输入、链选择到确认发送的全部交互文本均为简体中文。
- 交互流程与校验行为不变
- 错误消息仍为单行 throw，入口统一 `❌` 输出

#### 场景: 测试断言同步
`node --test tests/` 运行通过，stage-wait 测试对新中文错误文案断言成功。
- 测试逻辑不变，仅更新匹配的文案片段

## 风险评估
- **风险:** 漏译或错译导致 UI 中英越混杂；改动字符串意外影响逻辑（如正则/断言）
- **缓解:** 全库正则扫描越南语字符集复核；测试断言同步更新并跑 `npm run build` + `node --test`；diff 审查仅含字符串