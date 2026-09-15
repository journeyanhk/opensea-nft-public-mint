# 任务清单: review 修复（T-refresh 后二次预热 + 开售时间重锚边界）

目录: `helloagents/plan/202609152008_review-fixes/`

---

## 1. 修复
- [√] 1.1 在 `src/local-mint.ts` 抽出具名的纯函数 `reconcileStart(plannedMs, chainStartMs, nowMs, round)`，覆盖"推迟/提前/`planned=null` 但链上开售在未来"三类边界
- [√] 1.2 在 `src/local-mint.ts` 用 `reconcileStart` 替换原 `movedTo` 分支，使 `targetStart=null` 时也能等待被推迟的开售、并处理开售提前
- [√] 1.3 在 `src/local-mint.ts` 于 T-refresh 循环结束、拉 nonce 之前补一次 `warmConnections`，覆盖长等待后失效的 keep-alive 套接字

## 2. 配置安全
- [√] 2.1 在 `.gitignore` 增加 `targets.local.json`（可能内嵌 RPC key 的本地配置）
- [√] 2.2 在 `README.md` 批量模式章节提示不要把带 key 的 RPC 写入 `targets.json`

## 3. 安全检查
- [√] 3.1 执行安全检查（私钥/RPC key 不落库、错误信息不泄露、护栏不被绕过）

## 4. 文档更新
- [√] 4.1 更新 `helloagents/wiki/modules/local-mint.md`（二次预热、reconcileStart 边界）
- [√] 4.2 更新 `helloagents/wiki/modules/batch.md`（null start 处理、RPC key 提醒）
- [√] 4.3 更新 `helloagents/CHANGELOG.md`

## 5. 测试
- [√] 5.1 新增 `tests/local-mint.cjs`，断言 `reconcileStart` 五类输入
- [√] 5.2 运行 `npm run build` 与 `node --test tests/*.cjs`，确认无回归

---

## 执行总结

- 全部 10 项任务完成，`npm run build` 通过，`node --test tests/*.cjs` 19/19 通过（新增 5 个 `reconcileStart` 用例）。
- review 提出的两处代码问题经代码核实成立并已修复；第三条"RPC key 不入库"为非代码提醒，以 `.gitignore` + README 提示落实。
- 未触碰 `targets.json` 内容（当前不含 `rpcs`，无泄露）。

---

## 任务状态符号
- `[ ]` 待执行
- `[√]` 已完成
- `[X]` 执行失败
- `[-]` 已跳过
- `[?]` 待确认
