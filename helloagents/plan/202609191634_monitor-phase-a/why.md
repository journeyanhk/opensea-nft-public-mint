# 为什么: 监控优先阶段 A（日历信息源 + 秒空强化 + 保守估值）

目录: `helloagents/plan/202609191634_monitor-phase-a/`

## 背景

M5a/M5b 解决了"能不能铸到"和"值不值得"的**事后**判断；The Obscura 的失败证明真正的瓶颈是**看得不够远**：链上 `PublicDropUpdated` 往往在开售前几十分钟才出现，而 OpenSea 的 drops 日历提前数天就给出开售时间、地板价、认证状态与 drop 配置。同时该次失败暴露了"批量合约"这一最硬的秒空证据我们完全没采集。

mint-desk（MIT，journeyanhk fork）的实现已验证了页面解析路径：OpenSea 的 `/drops/upcoming` 通过 **`urql_transport` script push 的 JSON** 暴露 `dropCalendar.items`（不是 Next.js `__NEXT_DATA__`，实测 0 次），条目含 slug/名称/链/合约地址，collection 节点含 floor/topOffer/24h 量/isVerified/disabledReason/`drop.stages[].startTime`/maxSupply。

**实测（本机，2026-09-19）：** `/drops/upcoming` 跟随 307 到 `/drops`，1 MB 页面；`urql_transport` ×2、`dropCalendar` ×2；Robinhood 引用 196 处、**Arc 仅 2 处**（Arc 仍以链上事件为主源）；用该解析逻辑实跑拿到 3 个 robinhood upcoming（slug + 合约地址齐全）。

## 问题

1. **没有提前量**：面板只在链上事件后才认识一个目标，upcoming 视图实际只有"已配置但未开售"的少量项目。
2. **秒空判据缺最硬的一条**：The Obscura 首块 idx 2 一笔交易 100 个子钱包铸 1,000 个——我们只统计了预售占比/地址数/每钱包上限，没有"批量合约痕迹"。
3. **没有需求侧的链上信号**：谁在铸造比"铸了多少"更早、更难伪造；我们已扫描到的 `SeaDropMint` 足以派生"聪明铸造者集合"，但没有聚合。
4. **利润/流动性缺护栏**：地板价是卖方挂单，不等于能成交；现有面板没有"成交证据"这一层。

## 目标

- **A1**：OpenSea 日历成为 upcoming 的第二信息源（链上保完整，日历给提前量与质量标记），落状态并进面板；解析失败**必须报错**，绝不把"没解析到"当"没有项目"。
- **A3 + A4-lite**：批量合约痕迹进 `instant-sellout`；从已售罄 drop 的扫描数据自动派生"聪明铸造者集合"（无需人工维护名单），统计目标在预售阶段被集合中多少地址碰过，进审计与 Q 分。
- **A2**：把 mint-desk 的保守估值护栏（≥3 笔不同交易 + ≥2 个买家 + 近 6h 有成交；每买家一个中位数；参考价 = min(地板, 下四分位×0.8, topOffer)）做成纯函数并接入面板的流动性标签与创作者历史。

## 不在本包

- WS 实时订阅（需付费 WSS，收益是分钟级→秒级；本期优先"看未来几天"）。
- mint 侧：回执核数量、三道门、burst、钱包通道协调器（阶段 B）。
- 批量合约路线（单独立项）。
- Seaport 买卖/转账分类的重点钱包（mint-desk 完整版，A4-lite 只做铸造侧）。

## 风险

| 风险 | 应对 |
|---|---|
| 页面结构变化/被 Cloudflare 拦截 | 解析器 fail-loud + 真实结构 fixture；被拦截时退回 `drops/{slug}` API（有 key）；金丝雀检查（某链昨天有条目今天为 0 → 报警） |
| 页面 1 MB，频繁抓取浪费 | 独立节流（10–15 分钟一次），不与扫描 tick 绑定；UA 固定、跟随 307 |
| 日历 ≠ 全集（策展） | 链上事件仍是主源；日历只是提前量与质量标记，两个来源都保留 `sources` |
| 聪明铸造者被刷量污染 | 只取**售罄 drop** 的铸造地址、要求 ≥2 次出现；仅作为信号之一进入 Q 分（不单独决定） |
| 卖出证据样本太少 | 护栏本身就是"证据不足 → 不给参考价"，宁缺毋滥 |
