# serve 模块

## 目的
数据侧常驻服务：单进程内置调度器持续执行"扫描 → 回填 → 重建看板行"，并通过只读 HTTP 接口把看板提供到公网（经 Caddy 终止 TLS 与 basic_auth）。

## 模块概述
- **职责:** `serveConfig`/`assertNoPrivateKeys`（配置与私钥隔离）；`Scheduler`（互斥 tick、状态快照、日志环形缓冲、rows 缓存）；`createServer`/`runServe`（内置 `http`，6 个路由，无新依赖）
- **状态:** ✅稳定
- **最后更新:** 2026-09-18

## 规范
### 需求: 常驻调度
**模块:** serve
- 启动时立即跑一轮（`runScan` → `runBackfill` → `loadDashboardRows`），之后按 `SCAN_INTERVAL_MIN` 定时；上一轮未结束则跳过本次 tick（互斥）
- 单轮失败只写 `lastError` 与日志，进程不退出；下一轮自动重试
- 重启后从 `.scan-state.json`/`.scan-history.jsonl`/`.batch-state.json`/`.backfill.jsonl` 重建行，无需等扫描
- 日志环形缓冲保留最近 200 行（`/api/status` 返回最近 20 行，已脱敏）

### 需求: 私钥隔离（fail-closed）
**模块:** serve
- `--serve` 只加载 `.env.serve`（可用 `SERVE_ENV_FILE` 覆盖），**不加载 `.env`**
- 启动断言 `PRIVATE_KEY` / `PRIVATE_KEYS` 为空，否则打印错误并退出
- 执行 mint 仍在另一终端用 `.env` 跑 `--batch`；公网面板永远不接触私钥

### 需求: 公网看板
**模块:** serve
- 只绑 `SERVE_HOST`（默认 `127.0.0.1`）；由 Caddy 反代并终止 HTTPS + basic_auth；防火墙只放行 80/443
- `POST` 必须 `content-type: application/json`（跨站表单无法携带）且 `Origin` 与 Host 同源；不返回 CORS 头
- `/api/status` 脱敏：RPC URL 经 `maskRpc`、绝对路径替换为 `<path>`
- 页面含状态条（运行中/上次/下次/行数/最近日志）与 "Scan now"；15 秒轮询状态，页面 5 分钟自动刷新

## API接口
### 路由
| 方法 / 路径 | 行为 |
|---|---|
| `GET /healthz` | `{ ok: true }` |
| `GET /` | 服务模式看板（`renderDashboard(..., { serve: true })`） |
| `GET /api/status` | 状态 + 游标 + 最近日志（脱敏） |
| `GET /api/rows?chain=&grade=` | 行数据（服务端过滤） |
| `POST /api/scan` | 触发一轮；5 秒节流；运行中 409，触发成功 202 |

### 导出（`src/serve/`）
- `serveConfig(env)` → `ServeConfig`；`assertNoPrivateKeys(env)`
- `Scheduler`：`start/stop/tick/rebuildRows`，`rows`/`status`
- `createServer({ scheduler, exportsDir })`、`runServe(config)`、`sanitizeLog(lines)`

## 数据模型
`ServeConfig`: `{ host, port, chains, intervalMs, limit, lookbackDays, horizonHours, includeMints, exportsDir, statePath, historyPath, ledgerPath, backfillPath, cacheDir }`
`SchedulerStatus`: `{ running, lastScanAt, nextScanAt, lastError, chains, cursors, log, lastReports, backfill, rowCount }`

## 环境变量（.env.serve）
| 变量 | 默认 | 说明 |
|------|------|------|
| SERVE_HOST / SERVE_PORT | 127.0.0.1 / 8787 | 监听地址与端口 |
| SCAN_CHAINS | robinhood,arc | 调度链 |
| SCAN_INTERVAL_MIN | 15 | 扫描间隔（分钟） |
| SCAN_LIMIT | 20 | 每轮最多审计数 |
| SCAN_LOOKBACK_DAYS | 0.5 | 审计回看天数 |
| SCAN_HORIZON_HOURS | 72 | 只看此时段内开售 |
| SCAN_INCLUDE_MINTS | 0 | 发现是否包含 SeaDropMint |
| RPC_URL_* / SCAN_RPC_URL_* | 空 | 链上调用 / 扫描专用（可选） |
| OPENSEA_API_KEY | 空 | stats 与反查（可选） |

## 部署
`deploy/nft-serve.service`（systemd，低权限用户 + 加固）、`deploy/Caddyfile.example`（自动 HTTPS + basic_auth + 安全头）、`.env.serve.example`。服务不写任何文件（导出能力在 M4b）；`ReadWritePaths` 已为状态缓存与后续导出预留。

## 依赖
- scan（runScan）、backfill、html（渲染）、state/history、batch-ledger、rpc-resolver（maskRpc）、Node 内置 http

## 变更历史
- [202609181530_serve-m4a](../../history/2026-09/202609181530_serve-m4a/) - M4a：常驻调度 + 公网看板 + systemd/Caddy 部署文件
