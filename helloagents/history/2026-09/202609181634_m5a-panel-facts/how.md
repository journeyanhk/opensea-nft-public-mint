# 技术设计: M5a 面板基础事实与需求信号

## 技术方案

### 核心技术
- 纯复用既有数据管线：`auditTarget`（链上读取 + 事件扫描）→ `.scan-history.jsonl` → `loadDashboardRows` → `renderDashboard`；**不新增网络请求类型、不加依赖、不改 `SCAN_LOOKBACK_DAYS`**

### 1. 审计补齐事实（`src/audit/audit.ts`）

- `owner()`：与 `name()` 同一处读取，失败返回 null（renounced / 非 Ownable 常见）
- 速度桶：`estimateBlockTime` 已给出 `latestBlock` 与 `secondsPerBlock`，据此算出 15 分钟与 1 小时的起始块，交给 `aggregateMints` 一次性统计（日志已扫过，零额外 RPC）
- `MintScan` 增加 `recentByWindow: Record<string, bigint>`（`"15m"` / `"1h"`），保留 `recentTokens`（= 15m，评分逻辑不动）

### 2. 事件聚合多窗口（`src/audit/events.ts`）

```ts
export function aggregateMints(
  logs: RawLog[],
  recentFromBlock: number,
  extraCutoffs: { label: string; fromBlock: number }[] = []
): MintScan
```
在现有单窗口统计基础上，对每个 cutoff 累加 `blockNumber >= fromBlock` 的 `quantity`。

### 3. 历史记录扩字段（`src/scan/scanner.ts`）

`.scan-history.jsonl` 每条追加：

```jsonc
{
  // 既有: at, chain, contract, grade, risks, reason, coverage, remaining, projected, start
  "name": "HoodMiners", "owner": "0x…",
  "mintPriceWei": "0", "capPerWallet": 1, "endTime": 1789…,
  "maxSupply": "5000", "totalMinted": "5000",
  "recent15m": "12", "recent1h": "140",
  "uniqueMinters": 3760, "topMinterShare": 0.05,
  "stageCount": 3, "presaleStages": 2
}
```
旧行缺字段 → 面板显示 `—`（`parseHistory` 已有容错）。

### 4. 复审策略与候选排序（`src/scan/scanner.ts`）

`shouldAudit` 改为：

```
if (!entry) true
if (eventSinceAudit) true
if (entry.lastAuditedAt === null) true
if (soldOut && !eventSinceAudit) false
openedWithinHours(start, now, REAUDIT_OPENED_HOURS=72) 且距上次审计 > 30min → true   // 新增：已开售也复审
开售临近（start - now <= horizon）且距上次审计 > 30min → true
false
```

候选排序：`pendingAudit` 优先 → 已开售 72h 内（`lastAuditedAt` 越久越前）→ 新发现/临近开售；`--limit` 语义不变。

### 5. 面板字段与筛选（`src/scan/html.ts`）

`DashboardRow` 新增（全部来自最新历史点 + 状态）：

```ts
name: string | null;
owner: string | null;
mintPriceWei: string | null;   // "0" → FREE
capPerWallet: number | null;   // 0 = unlimited
endTime: number | null;
maxSupply: string | null;
minted: string | null;
recent15m: string | null;
recent1h: string | null;
uniqueMinters: number | null;
presaleStages: number | null;
velocity24h: string | null;        // 差分（或 1h 桶×24 的回退）
velocitySource: "differential" | "bucket" | null;
sellOutEtaHours: number | null;
stale: boolean;
links: { opensea: string; explorer: string };
```

纯函数（可测）：

```ts
export function velocityPer24h(points, nowMs, fallbackPerHour): { per24h: bigint|null; source: ... }
export function staleVerdict(input: { startSec, nowSec, mintedPct, velocityPer24h, maxSupply }): boolean
export function sellOutEtaHours(remaining: bigint|null, velocityPer24h: bigint|null): number | null
```

- 陈旧规则：开售 >24h 且 已铸 <10% 且 24h 速度 < `max(5, 0.1% × maxSupply)`
- 列：名称 / FREE·价格 / 上限 / 窗口（"opens in 3h"、"opened 2d ago · ends in 5d"）/ 已铸进度 / 15m / 1h / 地址数 / 集中度 / 预售 / 24h 速度（标 source）/ 售罄预计 / 陈旧 / 链接
- 新增预设按钮：`免费 · A/B · 隐藏陈旧`；陈旧默认隐藏并显示"已隐藏 N 个陈旧"；勾选"显示陈旧"恢复
- 现有筛选、排序、短名单、净值列保持不变

## 架构决策 ADR

### ADR-23: 24h 速度用审计差分，1h 速度用日志分桶
**上下文:** 24h 日志分桶需要把回看从 0.5 天加到 1 天以上（扫描成本翻倍）；而开售 72h 内每 30 分钟复审天然产出时间序列。
**决策:** 20 分钟级细粒度来自日志桶（15m/1h），小时级以上速度来自相邻审计的 `totalMinted` 差分；历史点不足时回退到 1h 桶并标注来源。
**替代方案:** 全用日志分桶 → 回看天数翻倍，且长窗口桶对"刚开售"没有意义。
**影响:** 面板必须带 `velocitySource` 标注；差分依赖连续审计（断档时回退）。

### ADR-24: 复审扩展为"开售 72 小时内每 30 分钟"，按最久未审优先排序
**上下文:** 已开售目标是面板的主体，不复审就没有速度序列；但全量复审会挤占 `--limit`。
**决策:** 仅对开售 72h 内的目标启用 30 分钟复审，候选按 `lastAuditedAt` 最久优先；单轮上限不变。
**替代方案:** 全量定期复审 → 目标数太多，等于没有速度数据；只复审未开售 → 面板永远看不到"开售后在掉血"的信号。
**影响:** 目标多时复审周期会自然拉长；`SCAN_LIMIT` 可调，面板的 `lastAuditedAt` 让用户可见。

### ADR-25: 陈旧是"显式过滤 + 计数"，不是静默丢弃
**上下文:** 死项目会把 896 行面板噪声化，但静默隐藏会让人不知道过滤了什么。
**决策:** 默认隐藏陈旧行，界面显示"已隐藏 N 个陈旧"，可一键恢复；`stale` 规则与阈值集中在一个纯函数。
**替代方案:** 直接丢弃（后端过滤）→ 用户无法复核判定是否正确；不过滤 → 面板不可用。
**影响:** 前端过滤（几百行毫秒级），后端 `/api/rows` 同步支持 `?stale=` 参数。

## 安全与性能
- **安全:** 新增字段全部来自链上读取与本地文件；`name`/`owner` 渲染继续走 `escapeHtml`；链接由链注册表生成（explorer/OpenSea 基础域），不采用外部输入。
- **性能:** 多窗口统计在既有日志数组上多做一次遍历；面板列增加不改变渲染复杂度；复审频率由 `--limit` 约束。

## 测试与部署
- **单元测试:** `aggregateMints` 多窗口切分；`velocityPer24h`（差分/回退/缺口）；`staleVerdict` 边界（恰好 24h、恰好 10%、速度 0）；`sellOutEtaHours`；`shouldAudit` 已开售复审与 30 分钟节流；历史字段往返（写→parseHistory→loadDashboardRows）；渲染断言（FREE 徽标、stale 属性、隐藏计数、链接）。
- **真链验收:** `--scan --chain robinhood --limit 3` 后检查历史行含新字段；`--serve` 页面出现名称/FREE/速度/陈旧列；陈旧过滤计数正确。
- **回归:** `npm run build` + `node --test tests/*.cjs`（现有 74 例不得回归）。
- **发布:** M5a 合入后部署观察 2–3 天，再定 M5b 的 Q 分权重初值。
