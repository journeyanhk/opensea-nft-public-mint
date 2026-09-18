# 变更提案: 数据侧服务化 M4a（常驻调度 + 公网看板）

## 需求背景

现有 M1–M3 已具备完整数据侧能力（`--scan` 发现审计、`--report` 看板、`--backfill` 回填、`--batch --watch` 执行），但只能靠 tmux 循环 + 手动重开页面。用户希望：

1. **常驻服务化**：一个进程持续做"扫描 → 回填 → 刷新看板"，页面随时可看；
2. **公网可访问**：服务器只开放 80/443，用 Caddy 反代到本机 `127.0.0.1:8787`，basic_auth 保护；
3. **先看到数据、再逐步加功能**：第一步（M4a）只做调度与只读看板，导出按钮等后续再加。

外部方案（`opsea-desgin5.md`）的 B 方案与本仓库接口基本吻合，但有 4 处必须加固，其中一处是私钥泄露缺口：

| 附件假设 | 实际情况 | 处理 |
|---|---|---|
| `--serve` 不调用 `walletKeysFromEnv` 即"不接触私钥" | `src/index.ts` 启动时**无条件 `dotenv.config(.env)`**，执行侧的 `PRIVATE_KEY` 会进入服务进程环境 | **必须修**：服务模式只读 `.env.serve`，并断言环境无密钥否则拒绝启动 |
| 导出用 `auditTarget` 全量审计 | 默认 7 天回看、缓存 TTL 5 分钟，点击导出时每个目标要重跑整段事件扫描（数秒到数十秒） | M4b 改为轻量校验（`buildLocalMintPlan` + `loadBatchConfig`），不做全量审计 |
| 建议 SSH 隧道优先、Caddy 可选 | 用户明确走 Caddy + 80/443 | 以 Caddy 为主线，文档写清域名与 HTTPS 前提 |
| POST 未提 CSRF | 公网暴露后需要 | POST 强制 JSON content-type + Origin 校验；状态接口屏蔽 RPC 密钥与本地路径 |

## 变更内容（M4a 本包范围）

1. 新增 `src/serve/`：`config.ts`（环境解析 + 私钥 fail-closed）、`scheduler.ts`（互斥调度 + 状态与日志环形缓冲）、`server.ts`（Node 内置 `http`，只读路由 + 触发扫描）。
2. `--serve` 入口：启动时立即扫一轮，之后按 `SCAN_INTERVAL_MIN` 定时；`GET /` 实时渲染看板，`GET /api/status`、`GET /api/rows`、`POST /api/scan`、`GET /healthz`。
3. `html.ts` 增加服务模式：状态条（上次/下次扫描、运行中、错误）、"Scan now"按钮、15 秒轮询状态。
4. 部署文件与文档：`deploy/nft-serve.service`（低权限用户 + systemd 加固）、`deploy/Caddyfile.example`（自动 HTTPS + basic_auth + 安全头）、`.env.serve.example`、README 部署章节。
5. `.gitignore` 增加 `.env.serve`、`exports/`；知识库同步。

**不在本包**：面板导出 API（M4b）、执行侧 `--yes`/第二个 systemd 服务（M5）、能力扩展。

## 影响范围

- **新增:** `src/serve/{config,scheduler,server}.ts`、`deploy/nft-serve.service`、`deploy/Caddyfile.example`、`.env.serve.example`、`tests/serve.cjs`
- **修改:** `src/index.ts`（按模式加载 env、`--serve` 分支、HELP）、`src/scan/html.ts`（服务模式状态条）、`.gitignore`、`README.md`、`helloagents/wiki/*`
- **安全:** 服务进程不含私钥（代码断言）；只绑 `SERVE_HOST`（默认 127.0.0.1）；POST 无写文件（M4a）；`/api/status` 屏蔽密钥与路径

## 核心场景

### 需求: 常驻调度
**模块:** serve

#### 场景: 启动即扫一轮，之后定时
`npm start -- --serve`（systemd 托管）。
- 启动后立即 `runScan` → `runBackfill` → 重建看板行；结束后设置 `nextScanAt`
- 每 `SCAN_INTERVAL_MIN` 再跑一轮；上一轮未结束时跳过本次 tick（互斥），状态里显示 `running`
- 单轮失败只记录 `lastError` 与日志，进程继续；下一轮重试
- `POST /api/scan` 可手动触发，运行中返回 409

#### 场景: 服务重启恢复
进程重启后从 `.scan-state.json`/`.scan-history.jsonl`/`.batch-state.json`/`.backfill.jsonl` 重建行，无需等待扫描。

### 需求: 公网看板
**模块:** serve / html

#### 场景: 浏览器访问
Caddy 终止 TLS 并做 basic_auth，反代到 `127.0.0.1:8787`。
- 页面渲染与 `--report` 同一套表格与筛选；顶部状态条显示 `last scan / next / running / chains`，可点 "Scan now"
- 状态条每 15 秒轮询 `/api/status`；页面每 5 分钟自动刷新
- `/api/status`、`/api/rows` 不返回 RPC URL 中的密钥，也不返回本地文件路径

### 需求: 私钥隔离
**模块:** serve/config

#### 场景: 服务进程不含私钥
systemd `EnvironmentFile=.env.serve`（只有 RPC / OpenSea key / 调度参数）。
- `--serve` 只加载 `.env.serve`（或直接使用进程环境），**不加载 `.env`**
- 启动断言：`PRIVATE_KEY` / `PRIVATE_KEYS` 任一非空 → 打印明确错误并退出（fail closed）
- 单元测试覆盖：带密钥环境必须抛错

## 风险评估

- **风险:** 公网暴露面板，basic_auth 被爆破或凭据泄露。**缓解:** 仅 80/443 对外、`127.0.0.1` 绑定、HTTPS（Caddy 自动证书）、强密码、`/api/scan` 5 秒节流；文档明确建议再加 fail2ban 或 IP 白名单。
- **风险:** 服务进程意外持有私钥。**缓解:** 不加载 `.env` + 启动断言（测试锁定）。
- **风险:** CSRF 触发扫描或（M4b 的）导出。**缓解:** POST 强制 `content-type: application/json`（跨站表单无法携带，触发预检且我们无 CORS 头）+ 校验 `Origin` 与 Host 一致。
- **风险:** 服务与手动 CLI 同时写 `.scan-state.json` 互相覆盖。**缓解:** 文档规定服务模式下不要手动跑 `--scan/--backfill`；调度器自身互斥；后续如需可加锁文件。
- **风险:** 无域名导致 HTTPS 不可用。**缓解:** 文档给出两种路径（有域名用 Caddy 自动证书；无域名用 `tls internal` 自签并在浏览器信任，或临时 `http://` 仅内网）。
- **风险:** 首轮扫描耗时（Robinhood 1 天回填数分钟）期间页面无数据。**缓解:** 启动即扫 + 状态条显示进度日志（环形缓冲），页面可见"扫描中"。
