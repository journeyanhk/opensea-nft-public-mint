# Changelog

本文件记录项目所有重要变更。
格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/),
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 变更
- 全部越南语文案翻译为简体中文（CLI 界面、错误提示、README、安装脚本、.env 注释），不改变任何功能与时区语义
- CLI 界面文案由中文翻译为英语（README 等文档保持中文）
- 时区语义由越南时间 UTC+7 切换为 UTC+8（展示与输入均按 UTC+8；`time-format.ts` 符号重命名为 toUtc8Time/utc8TimeToDate）