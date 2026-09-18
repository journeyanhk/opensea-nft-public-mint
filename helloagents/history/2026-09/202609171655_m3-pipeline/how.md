# 技术设计: M3 扫描→执行闭环（M3a → M3b → M3c）

## 技术方案

### 核心技术
- TypeScript / Node 18+；无新依赖（HTML 为手写模板，无前端框架；HTTP 仅在 M3c 用已有 `fetch`）
- 复用：`loadBatchConfig`（校验与解析目标）、`localPublicSnipe`（执行）、`auditTarget`（复检）、`state.ts`（扫描状态）、`report.ts`（导出）

### 模块结构

```
src/batch-ledger.ts   执行账本（.batch-state.json，原子写）
src/batch-watch.ts    配置合并与队列调度（纯函数为主）
src/scan/html.ts      --report 的单文件 HTML 生成
src/scan/backfill.ts  地板价回填（.feedback.jsonl）
```

## M3a 队列热加载

### 数据流

```
读取主配置 + --watch 附加文件
  → mergeRawConfigs()（按 slug/地址小写去重，主配置优先）
  → loadBatchConfig()（解析/校验/读链上公售，失败目标剔除并告警）
  → 与内存队列 + 账本比对：
       已完成（账本 SUCCESS/REVERTED/TIMEOUT 或 txHash 存在）→ 跳过
       正在执行 → 保留
       新目标 → 余额预检 → 插入待执行队列（按 startAt 升序）
       配置中消失且未执行 → 移除并记录
  → 打印变更摘要（+N 新增 / -M 移除 / K 已完成跳过）
```

- 轮询间隔 `--watch-interval`（默认 60s）；重读失败（文件半写）保留上一版并告警
- 新目标执行前**必须**通过：`loadBatchConfig` 的 `maxPriceEth` 校验（付费目标缺上限直接拒绝）+ 该目标余额预检（`value + gasLimit × maxFee`）；单个新目标不合格只跳过它，不终止批量
- 执行循环抽为 `executeTarget(target, ctx)`，watch 循环与首轮共用；等待/审计/签名/广播逻辑不变
- 账本写入时机：广播前记 `pending`（含 txHash 未知），收到结果后更新；崩溃在广播与记账之间时，重启会看到 `pending`，此时按"可能已广播"处理（默认跳过，`--retry-pending` 可强制重试）

### 账本模型

```jsonc
// .batch-state.json
{
  "version": 1,
  "entries": {
    "robinhood": {
      "0xd7ab…2599": {
        "status": "SUCCESS",            // SUCCESS | REVERTED | TIMEOUT | REJECTED | SKIPPED | PENDING
        "txHash": "0x…",               // 有值即代表已广播
        "at": "2026-09-17T08:30:00Z",
        "quantity": 3
      }
    }
  }
}
```

跳过规则（纯函数 `shouldSkipLedger(entry, opts)`）：
- `txHash !== null` → 跳过（无论状态）
- `status === "SUCCESS" | "REVERTED" | "TIMEOUT"` → 跳过
- `status === "SKIPPED" | "REJECTED"` → 允许重试
- `status === "PENDING"` → 跳过，除非 `--retry-pending`

## M3b 静态看板

### 数据与渲染
- 输入：`.scan-state.json`（合约列表、等级、publicStart、pendingAudit、soldOut）+ `.scan-history.jsonl`（等级与余量随时间的变化）
- 组装：每个合约取最新一条 history 作为当前行，附上最近 N 条做等级变化列
- 输出：单文件 HTML，内联 CSS + 原生 JS：
  - 表格：链、合约（可复制）、等级徽标、开售时间（UTC+8）、剩余/预计、最近审计、风险摘要
  - 筛选：等级多选、链、仅显示 pending、按开售时间/等级排序
  - 勾选：生成 `<textarea>` 里的短名单（每行合约地址）+ 现成命令（`--audit @shortlist.txt …`、`--export …`），复制按钮用 `navigator.clipboard`
  - 无外部字体/脚本/CDN；`<meta charset>` + `escapeHtml()` 处理所有动态字段
- 纯函数 `renderDashboard(rows, meta): string` 可单测（转义、排序、筛选标记不依赖浏览器）

## M3c 地板价回填

### 流程
```
读取账本 + .feedback.jsonl
  → 选到期目标：status SUCCESS 且 age ≥ 阈值（默认 [24h, 72h]）且 (contract, checkpoint) 未回填
  → 需要 slug：账本记录导出时的 slug（写账本时一并保存），缺失时用 chain/{chain}/contract/{addr} 反查
  → GET collections/{slug}/stats → { floor_price, volume, ... }
  → 追加 .feedback.jsonl
```

- 回填记录：`{ at, chain, contract, slug, checkpointHours, floorPrice, volume, currency }`
- 无 key / 401 / 429：打印原因并跳过该目标；整批结束打印跳过数
- 不做权重自动调整（留给两周后的数据评审）

## 架构决策 ADR

### ADR-16: watch 即预授权，但受价格护栏与余额预检约束
**上下文:** 无人值守需要新目标自动执行；但自动执行有误操作风险。
**决策:** `--watch` 明确表示预授权；新目标仍必须通过 `maxPriceEth` 与余额预检，并在执行前打印完整参数；`--watch-interval` 可调。
**替代方案:** 每个新目标弹确认 → 拒绝原因: 违背无人值守目标；全自动选目标 → 拒绝原因: 评分不能判断"值不值钱"，仍需人勾选导出。
**影响:** watch 模式只应指向自己导出的 `targets.scan.*.json`。

### ADR-17: 执行账本以"是否已广播"为唯一真值
**上下文:** 重启后重读配置可能重复 mint；链上 txHash 存在即代表资金已动用。
**决策:** 账本在广播前写 `PENDING`，收到结果后更新；任何 `txHash` 非空的状态一律跳过。
**替代方案:** 仅内存去重 → 拒绝原因: 重启即失去保护；链上 nonce 检查 → 拒绝原因: 无法区分"同 nonce 已用"与"钱包正常活动"。
**影响:** `--no-ledger` 仅用于显式放弃保护。

### ADR-18: 看板静态化、回填可选化
**上下文:** M3b 的浏览频率低、数据量小；M3c 硬依赖可能不可用的 OpenSea key。
**决策:** 看板生成单文件 HTML（无 server）；回填作为独立命令，失败只跳过。
**替代方案:** Fastify + SQLite 看板 → 拒绝原因: 引入依赖与常驻进程，收益不足；回填并入 scan → 拒绝原因: 依赖 key，会让扫描整体失败。
**影响:** 看板信息不含实时链上数据，需要时可重新 `--scan` 再生成。

## 安全与性能
- **安全:** 账本与反馈文件只含链上地址/时间/价格，不含私钥；HTML 全字段转义；watch 不读取预期外的文件（仅显式传入的路径）。
- **性能:** watch 每轮成本 = 重读 JSON + 解析新增目标（未变化时 0 次 RPC，按内容哈希跳过）；看板生成为纯本地字符串拼接；回填每次网络调用间隔 ≥500ms。

## 测试与部署
- **单元测试:** `mergeRawConfigs`（去重/主配置优先）、`shouldSkipLedger`（六种状态 × txHash）、`pruneQueue`（移除已消失目标）、`renderDashboard`（转义、排序、筛选）、`dueCheckpoints`（24/72h 到期选择）。
- **真链验收:** M3a 用扫描导出的免费目标在 watch 下自动执行一笔；M3b 用真实状态生成 HTML；M3c 有 key 时回填一笔历史 SUCCESS。
- **部署:** M3a 与 M2 的扫描进程分别常驻（两个 tmux 窗口）；M3b 按需生成；M3c 每天 cron 一次。
- **回归:** `npm run build` + `node --test tests/*.cjs`（现有 44 例不得回归）。
