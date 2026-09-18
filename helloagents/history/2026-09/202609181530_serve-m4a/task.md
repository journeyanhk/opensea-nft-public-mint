# 任务清单: 数据侧服务化 M4a（常驻调度 + 公网看板）

目录: `helloagents/plan/202609181530_serve-m4a/`

---

## 1. 配置与安全隔离
- [√] 1.1 新增 `src/serve/config.ts`：`serveConfig(env)`（SERVE_HOST/PORT、SCAN_CHAINS、SCAN_INTERVAL_MIN、SCAN_LIMIT、SCAN_LOOKBACK_DAYS、SCAN_HORIZON_HOURS、SCAN_INCLUDE_MINTS、EXPORTS_DIR 及文件路径覆盖）与 `assertNoPrivateKeys(env)`，验证 why.md#[需求-私钥隔离]-[场景-服务进程不含私钥]
- [√] 1.2 `src/index.ts` 改为按模式加载 env（`--serve` → `.env.serve` 且断言无密钥，否则 `.env`），并新增 `--serve` 分支与 HELP，依赖任务1.1

## 2. 调度器
- [√] 2.1 新增 `src/serve/scheduler.ts`：`Scheduler`（互斥 tick、`start/stop`、状态快照、日志环形缓冲 200 行、rows 缓存），单轮 = `runScan` → `runBackfill` → `loadDashboardRows`，验证 why.md#[需求-常驻调度]-[场景-启动即扫一轮-之后定时]
- [√] 2.2 失败只记录 `lastError` 不退出；重启后可从四个本地文件重建 rows，验证 why.md#[需求-常驻调度]-[场景-服务重启恢复]

## 3. HTTP 服务
- [√] 3.1 新增 `src/serve/server.ts`：`createServer`/`runServe`，路由 `GET /healthz`、`GET /`（服务模式看板）、`GET /api/status`（脱敏：`maskRpc`、去绝对路径）、`GET /api/rows`、`POST /api/scan`（JSON、Origin 同源、5 秒节流、409），验证 why.md#[需求-公网看板]-[场景-浏览器访问]，依赖任务2.1
- [√] 3.2 `src/scan/html.ts` 增加 `renderDashboard(rows, meta, { serve })`：状态条 + "Scan now" + 15 秒轮询脚本；表格/筛选/排序/短名单/净值列保持不变，依赖任务3.1

## 4. 部署文件
- [√] 4.1 新增 `deploy/nft-serve.service`（User=nft、`EnvironmentFile=.env.serve`、`NoNewPrivileges`、`ProtectSystem=strict`、`ReadWritePaths` 限定仓库、Restart=always）
- [√] 4.2 新增 `deploy/Caddyfile.example`（自动 HTTPS、basic_auth、`reverse_proxy 127.0.0.1:8787`、HSTS/X-Content-Type-Options/X-Frame-Options）与 `.env.serve.example`
- [√] 4.3 `.gitignore` 增加 `.env.serve`、`exports/`

## 5. 安全检查
- [√] 5.1 执行安全检查：服务模式无密钥（代码断言 + 测试）、只绑 127.0.0.1、POST 有 content-type/Origin/节流、状态脱敏、M4a 无写文件路径

## 6. 文档
- [√] 6.1 新增 `helloagents/wiki/modules/serve.md`；更新 `overview.md`、`arch.md`（架构图 + ADR-19~22）
- [√] 6.2 更新 `README.md`（部署章节：域名与 HTTPS 前提、Caddy 安装、.env.serve、systemd、仅开 80/443、验收命令）与 `CHANGELOG.md`

## 7. 测试与验收
- [√] 7.1 `tests/serve.cjs`：`assertNoPrivateKeys`、`serveConfig`、HTTP 集成（随机端口：healthz/status 脱敏/rows/scan 触发与 409/错误 content-type 415/Origin 403/404）
- [√] 7.2 本地冒烟：`--serve` + Arc 小窗口，`curl` 验证 `/healthz`、`/api/status`、`/` 含数据与状态条；确认进程环境无密钥
- [√] 7.3 `npm run build` 与 `node --test tests/*.cjs` 通过（现有 66 例不回归）
- [?] 7.4 部署验收（用户在服务器执行）：systemd + Caddy 后浏览器可见面板与状态条
  > 备注: 需要域名与 80/443；部署命令见 README「服务化部署」章节

---

## 执行总结

**结果:** 15/16 完成，1 项待用户在服务器执行部署验收。`npm run build` 通过，`node --test tests/*.cjs` **71/71**（新增 5 例）。

**本地真链冒烟（Arc，真实调度器）：**

```
[serve] listening on http://127.0.0.1:8790 — chains arc, every 15min, rows 0
/healthz → {"ok":true}
arc: 260 contracts (260 new) → arc:1 audited → scan done
/api/status → running false, rowCount 121, lastError null, 日志尾部正常
GET / → 含 statusBar + 121 行 data-chain 记录
进程环境 PRIVATE_KEY 计数 = 0
SIGTERM → 优雅退出
```

**关键安全落实：** `--serve` 只加载 `.env.serve`；启动断言环境无 `PRIVATE_KEY(S)`；只绑 `127.0.0.1`；POST 强制 JSON + Origin 同源 + 5 秒节流；`/api/status` 日志脱敏（RPC key 与绝对路径）；进程无写文件能力（M4b 才写 `exports/`）。

**下一步（M4b）:** 面板导出 API（`POST /api/export` 走轻量校验：`buildLocalMintPlan` + `loadBatchConfig`，不做全量审计）与 `exports/` 下载、文件名白名单。

---

## 任务状态符号
- `[ ]` 待执行
- `[√]` 已完成
- `[X]` 执行失败
- `[-]` 已跳过
- `[?]` 待确认
