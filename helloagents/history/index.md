# 变更历史索引

本文件记录所有已完成变更的索引，便于追溯和查询。

---

## 索引

| 时间戳 | 功能名称 | 类型 | 状态 | 方案包路径 |
|--------|----------|------|------|------------|
| 202609141442 | zh-cn-i18n | 重构 | ✅已完成 | [链接](2026-09/202609141442_zh-cn-i18n/) |
| 202609141521 | cli-en | 重构 | ✅已完成 | [链接](2026-09/202609141521_cli-en/) |
| 202609151934 | batch-timed-mint | 功能 | ✅已完成 | [链接](2026-09/202609151934_batch-timed-mint/) |
| 202609152008 | review-fixes | 修复 | ✅已完成 | [链接](2026-09/202609152008_review-fixes/) |
| 202609161339 | supply-check | 修复 | ✅已完成 | [链接](2026-09/202609161339_supply-check/) |
| 202609171345 | arc-chain | 功能 | ✅已完成 | [链接](2026-09/202609171345_arc-chain/) |
| 202609171426 | target-audit | 功能 | ✅已完成 | [链接](2026-09/202609171426_target-audit/) |
| 202609171557 | scan-discovery | 功能 | ✅已完成 | [链接](2026-09/202609171557_scan-discovery/) |
| 202609171654 | m2-review-fixes | 修复 | ✅已完成 | [链接](2026-09/202609171654_m2-review-fixes/) |
| 202609171745 | scan-rpc-role | 修复 | ✅已完成 | [链接](2026-09/202609171745_scan-rpc-role/) |
| 202609171655 | m3-pipeline | 功能 | ✅已完成 | [链接](2026-09/202609171655_m3-pipeline/) |
| 202609181443 | m3c-seaport-fix | 修复 | ✅已完成 | [链接](2026-09/202609181443_m3c-seaport-fix/) |
| 202609181530 | serve-m4a | 功能 | ✅已完成 | [链接](2026-09/202609181530_serve-m4a/) |

---

## 按月归档

### 2026-09

- [202609141442_zh-cn-i18n](2026-09/202609141442_zh-cn-i18n/) - 全量越南语文案翻译为简体中文（CLI/README/安装脚本/.env 注释），不改变功能与时区语义
- [202609141521_cli-en](2026-09/202609141521_cli-en/) - CLI 文案英文化（文档保持中文）+ 时区切换为 UTC+8
- [202609151934_batch-timed-mint](2026-09/202609151934_batch-timed-mint/) - 新增 `--batch` 多目标顺序定时公售（targets.json、余额预检、单次确认、T-3s 重读/重锚与价格护栏、SnipeResult 汇总）
- [202609152008_review-fixes](2026-09/202609152008_review-fixes/) - review 修复：T-refresh 后二次预热；开售时间漂移（planned=null / 提前）改由 reconcileStart 裁决；targets.local.json 入库防护
- [202609161339_supply-check](2026-09/202609161339_supply-check/) - 实战复盘修复：getMintStats 售罄检查（T-refresh 跳过售罄目标、剔除已达上限钱包）与批量日程剩余量展示
- [202609171345_arc-chain](2026-09/202609171345_arc-chain/) - Arc 链接入（chainId 5042）、gas 默认值按链配置、批量广播前 base fee 预检、向导路径补供应量检查
- [202609171426_target-audit](2026-09/202609171426_target-audit/) - `--audit` 目标审计（两套余量、SeaDropMint 分阶段曲线、变更史、A/B/C/D、导出）与批量前置审计 M1.5
- [202609171557_scan-discovery](2026-09/202609171557_scan-discovery/) - `--scan` 发现器（单例事件 OR 扫描、每链游标 + 确认延迟、候选过滤、JSONL 快照、Arc 限流适配）
- [202609171654_m2-review-fixes](2026-09/202609171654_m2-review-fixes/) - M2 review 修复：发现窗口自适应二分与 10k 窗口、全链串行扫描、超限候选积压队列（pendingAudit）、局部扫描的覆盖率标注
- [202609171745_scan-rpc-role](2026-09/202609171745_scan-rpc-role/) - review5 修复：扫描 RPC 角色分离（SCAN_RPC_URL_<CHAIN>）、范围错误采用节点提示/换端点/不重试、发现主题收窄为 PublicDropUpdated
- [202609171655_m3-pipeline](2026-09/202609171655_m3-pipeline/) - M3：队列热加载 `--watch` + 执行账本、静态看板 `--report`、回填 `--backfill`（链上成本 + 地板价）
- [202609181443_m3c-seaport-fix](2026-09/202609181443_m3c-seaport-fix/) - review8 修复：Seaport 1.6 五字段 OrderFulfilled 成交地板价、ERC-20 精度按 decimals 解析、净值统一 USD
- [202609181530_serve-m4a](2026-09/202609181530_serve-m4a/) - M4a 数据侧服务化：`--serve` 常驻调度 + 公网看板、私钥 fail-closed、systemd/Caddy 部署文件