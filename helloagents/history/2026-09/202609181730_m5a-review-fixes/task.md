# 任务清单: review9 修复（表头对齐 + 复审调度 + 链接/过滤）

目录: `helloagents/plan/202609181730_m5a-review-fixes/`

---

## 1. 阻塞项：表头与单元格错位
- [√] 1.1 `src/scan/html.ts`：`<thead>` 改为与行一一对应的 20 列（新增 price/cap/minted/left/15m·1h/minters/presale/velocity/stale/links），删除失效的 `remaining/projected/notes` 旧表头
- [√] 1.2 恢复 **left（剩余量）** 独立单元格；行上补齐 `data-mintprice/data-remaining/data-notes`，使表头 `data-sort` 键全部有效
- [√] 1.3 `tests/dashboard.cjs`：新增"表头 `<th>` 数 = 每行 `<td>` 数"与"每个 sort 键都有对应 data 属性"的断言

## 2. 复审不再挤占新发现
- [√] 2.1 `selectAuditBatch(pending, fresh, limit, reaudit)`：新工作优先、复审填充余量（复审未选中不记积压，下轮按最久未审重排）
- [√] 2.2 `state.ContractEntry` 增加 `lastMintedTotal/quietStreak`；连续两次无新增铸造的目标复审间隔放宽到 2 小时（`QUIET_REAUDIT_MS`）
- [√] 2.3 测试：`selectAuditBatch` 四组选择语义；`shouldAudit` quiet 降频边界

## 3. 链接与过滤
- [√] 3.1 历史记录写入 `slug`；OpenSea 链接优先 `/collection/<slug>`，否则 `/assets/<chain>/<contract>/1`
- [√] 3.2 `free only` 保留价格未知的行并显示 `N price unknown`
- [√] 3.3 测试：slug 链接与无 slug 回退

## 4. 文档与验证
- [√] 4.1 更新 `CHANGELOG.md`、`wiki/data.md`（slug 与状态字段）、`modules/scan.md`（排序与降频）、`README.md`（价格未知提示）
- [√] 4.2 真链冒烟：Arc 小窗口一轮，确认状态写入 `lastMintedTotal/quietStreak`
- [√] 4.3 `npm run build` 与 `node --test tests/*.cjs`（**83/83**）

## 执行总结

**结果:** 9/9 完成。表头实际已是旧 13 列对 19 单元格（上一轮替换静默失败），现已 20/20 对齐并通过结构断言。

**偏离说明（复审配额）:** review 建议"复审名额上限为 limit 的一半"，实现改为**新工作优先、复审填充余量**——因为在新工作优先的排序下，硬性半额上限会在没有新目标时浪费名额；该排序已保证新发现/积压不会被挤占（测试锁定）。同时按 review 第 3 条把"连续两次无新增"的目标降频到 2 小时。
