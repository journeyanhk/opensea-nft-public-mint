# 任务清单: review5 修复（扫描 RPC 角色分离 + 密度错误识别 + 发现主题收窄）

目录: `helloagents/plan/202609171745_scan-rpc-role/`

---

## 1. RPC 角色分离（根因）
- [√] 1.1 在 `src/rpc-resolver.ts` 新增 `resolveScanRpcs(chainKey)`：`SCAN_RPC_URL_<CHAIN>` → 公共端点 → `.env` 私有端点（发送仍用私有优先的 `resolveRpcsForChain`）
- [√] 1.2 `src/scan/scanner.ts` 与 `src/audit/audit.ts` 的日志/区块读取改用 `resolveScanRpcs`；扫描启动打印来源
- [√] 1.3 `.env.example` 与 README 增加 `SCAN_RPC_URL_<CHAIN>` 说明

## 2. 密度/范围错误的识别与处理
- [√] 2.1 `isRangeError` 覆盖 Arc `query exceeds max results 2000, retry with the range A-B` 与 Alchemy `up to a 10 block range` 文案；新增 `parseRangeHint`（两种句式）与 `isEndpointUnusable`
- [√] 2.2 `scanLogs` 改为接受 `rpcUrls: string[]`：不可用端点（提示范围 <64 块）自动切换；可用的提示范围直接按块数切分，否则二分
- [√] 2.3 `withRetry` 对范围类错误不再重试（确定性错误），只对限流/网络错误退避

## 3. 发现主题收窄
- [√] 3.1 `discoveryTopics(includeMints = false)` 默认只订阅 `PublicDropUpdated`；`--include-mints` 显式开启 `SeaDropMint`
- [√] 3.2 `discoveryWindowBlocks(chainKey, includeMints)`：仅配置事件用链默认窗口（Robinhood 100k / Arc 5k），带 mint 时降到 10k

## 4. 测试
- [√] 4.1 `tests/scan.cjs`：二分（旧文案）、采用节点建议范围、Alchemy 端点切换、范围错误不重试；`discoveryTopics` 默认/开启
- [√] 4.2 `tests/audit.cjs` 的 mock 适配 `rpcUrls` 参数
- [√] 4.3 `npm run build` 与 `node --test tests/*.cjs` 通过（47/47，新增 3 例）

## 5. 文档
- [√] 5.1 更新 `README.md`、`.env.example`、`helloagents/wiki/modules/rpc.md`、`modules/scan.md`、`modules/audit.md`、`wiki/data.md`、`CHANGELOG.md`

---

## 执行总结

**结果:** 11/11 完成。`npm run build` 通过，`node --test tests/*.cjs` **47/47**（新增 3 例：建议范围采用、端点切换、范围错误不重试）。

**真链验证（公共 RPC）：**

| 场景 | 修复前 | 修复后 |
|---|---|---|
| Robinhood `--since-days 1` | 用 `.env` 私有节点扫日志（Alchemy 免费档 10 块）→ 必失败 | 公共端点优先：**9 窗口 / 446 合约 / 2 分 32 秒**（此前带 mint 主题为 86 窗口 / 5 分 14 秒） |
| Arc `--since-days 0.05` | 密度文案不匹配时被当瞬时错误重试 8 次 | 2 窗口 / 12 合约，无重试浪费 |

**说明:** Alchemy 的 10 块上限在本机无法复现（无 `.env` 与 key），已用 mock RPC 覆盖端点切换路径；Arc 的建议范围路径同样由 mock 覆盖（真链 5k 窗口当前未触发）。

**未做（按用户要求）:** M3（热加载/看板/回填）暂不开工。

---

## 任务状态符号
- `[ ]` 待执行
- `[√]` 已完成
- `[X]` 执行失败
- `[-]` 已跳过
- `[?]` 待确认
