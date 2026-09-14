# 技术设计: CLI 界面文案英文化 + 时区切换为 UTC+8

## 技术方案
### 核心技术
- TypeScript 5.3 / Node.js 18+；不引入新依赖
- 纯字符串替换 + 一处时区常量/命名调整，不改动控制流

### 实现要点
- 逐文件将 CLI 字符串替换为自然英语，保留变量插值（`${...}`）与 ANSI 颜色调用
- 术语：Public、Allowlist、WL FCFS、SeaDrop、gas/wei/gwei、RPC、sequencer、base fee 等保留
- 时区：`UTC8_OFFSET_MS = 8 * 60 * 60 * 1000`；显示标签统一为 `UTC+8`；`vi-VN`/`Asia/Ho_Chi_Minh` → `en-US`/`Asia/Shanghai`；`GMT+7` → `GMT+8`
- 函数重命名：`toVNTime` → `toUtc8Time`，`vnTimeToDate` → `utc8TimeToDate`（同步 wizard.ts 导入）
- `prompt.ts` askYesNo：移除中文输入"是/否"，仅保留 y/yes/n/no
- `tests/stage-wait.cjs` 正则同步新英语错误消息

## 架构设计
无架构变更（文案层 + 常量/命名调整）。

## 架构决策 ADR
### ADR-2: CLI 英文化、文档保持中文
**上下文:** 用户希望 CLI 界面为英语（CLI 工具惯例），同时文档（README/.env.example/安装脚本）保持刚完成的中文。
**决策:** 仅翻译 `src/` 用户可见文案为英语；文档不翻译。
**理由:** 用户明确指定"命令行界面"，CLI 与文档的使用场景不同（工具交互 vs 阅读说明）。
**替代方案:** 全量回退为英语 → 拒绝原因: 与用户指令不符，文档中文已为既定成果。
**影响:** CLI 与 README 语言不一致，属预期结果。

### ADR-3: 时区由 UTC+7 切换为 UTC+8（取代 ADR-1 的时区决策）
**上下文:** 原工具面向越南用户，按 UTC+7 展示与输入开售时间；用户要求改为 UTC+8。
**决策:** 偏移常量改为 +8 小时，展示标签 UTC+8，`toLocaleString` 使用 `Asia/Shanghai`，内部命名去越南化。
**理由:** 用户明确要求；UTC+8 与用户所在时区一致，避免手动换算。
**替代方案:** 保持 UTC+7 → 拒绝原因: 与用户指令不符。支持可配置时区 → 拒绝原因: 超出当前需求范围。
**影响:** 自定义时间输入的语义随之改变（HH:MM 解释为 UTC+8）；历史记录中的 ADR-1 保留但被本决策取代。

## API设计
无对外 API。`time-format.ts` 导出符号重命名（`toUtc8Time`/`utc8TimeToDate`），仅内部消费。

## 数据模型
无变更。

## 安全与性能
- **安全:** 不触碰私钥处理逻辑；仅改错误消息文本
- **性能:** 无影响

## 测试与部署
- **测试:** `npm run build`（tsc 编译通过）+ `node --test tests/*.cjs` + `toUtc8Time` 已知时间戳校验
- **部署:** 无需部署（本地 CLI）