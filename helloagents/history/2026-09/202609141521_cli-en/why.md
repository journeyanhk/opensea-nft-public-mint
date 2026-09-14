# 变更提案: CLI 界面文案英文化 + 时区切换为 UTC+8

## 需求背景
CLI 界面（src/ 全部用户可见文案）刚由越南语翻译为简体中文，用户希望命令行界面使用英语（CLI 工具通用惯例），文档（README、.env.example、安装脚本）保持中文不变。同时用户要求将时间语义从越南时间 UTC+7 切换为 UTC+8（展示与输入均按 UTC+8）。

## 变更内容
1. 将 `src/` 全部用户可见文案（提示、菜单、日志、错误消息、HELP、banner）由中文翻译为英语
2. 时区从 UTC+7 切换为 UTC+8：偏移常量、显示标签（UTC+8）、`toLocaleString` 时区（Asia/Shanghai）、"GMT+7" → "GMT+8"
3. `time-format.ts` 内部命名去越南化：`VN_OFFSET_MS`/`toVNTime`/`vnTimeToDate` → `UTC8_OFFSET_MS`/`toUtc8Time`/`utc8TimeToDate`
4. `prompt.ts` 的 askYesNo 输入识别：移除中文"是/否"，仅保留 y/yes/n/no
5. 同步更新 tests/stage-wait.cjs 中依赖错误文案的断言
6. 保持品牌名与技术术语不变

## 影响范围
- **模块:** wizard、prompt、index、local-mint、rpc-blast、timer、connection-warmer、allowlist、stage-wait、time-format、nft-link、slug-resolver、rpc-resolver、wallet-keys
- **文件:** 14 个 src/*.ts + tests/stage-wait.cjs（15 个）
- **API:** 无对外 API；`time-format.ts` 导出函数重命名（内部使用）
- **数据:** 无变更

## 核心场景

### 需求: CLI 全量英文化
**模块:** 全部 CLI 模块
用户运行 `npm start` 后，从 banner、私钥输入、链选择到确认发送的全部交互文本均为英语。

#### 场景: 英语界面运行
CLI 所有提示、菜单、错误、状态输出为自然英语，交互流程与校验行为不变。

### 需求: 时区切换为 UTC+8
**模块:** time-format / wizard / stage-wait
展示时间与自定义时间输入均按 UTC+8 解释与呈现。

#### 场景: UTC+8 时间显示与输入
- 链上开售时间以 UTC+8 展示（如 `14/09/2026, 21:05:00 UTC+8`）
- 用户输入 `HH:MM` 被解释为"今天 UTC+8 的该时刻"，再换算为 UTC Date 发送
- stage-wait 日志使用 `en-US` locale + `Asia/Shanghai` 时区，显示 GMT+8

#### 场景: 测试断言同步
`node --test tests/*.cjs` 通过，stage-wait 测试对新的英语错误文案断言成功。

## 风险评估
- **风险:** 漏译/错译导致中英混杂；时区偏移改错导致发送时机偏差；断言未同步
- **缓解:** 全库扫描 src/tests 中文残留；对 `toUtc8Time` 做单元验证（对比已知时间戳）；断言同步更新；build + 测试验证