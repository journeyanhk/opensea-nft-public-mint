# 架构设计

## 总体架构
```mermaid
flowchart TD
    A[src/index.ts 入口] --> B[wizard 交互向导]
    B --> C[seadrop-public 本地构造 calldata]
    B --> D[allowlist Drops API 路径]
    C --> E[local-mint 预签名]
    E --> F[rpc-blast 多 RPC 并发广播]
    F --> G[回执轮询]
    D --> H[stage-wait 轮次等待]
    B --> I[prompt 交互层]
    B --> J[rpc-resolver RPC 选择]
```

## 技术栈
- **后端:** TypeScript / Node.js 18+（单进程 CLI）
- **链上:** ethers 6（签名、ABI 编码）
- **依赖:** chalk（彩色输出）、dotenv（配置）、ora（倒计时 spinner）

## 核心流程
```mermaid
sequenceDiagram
    User->>wizard: 输入私钥/链/数量/NFT/RPC/gas
    wizard->>seadrop-public: 读 getPublicDrop / getAllowedFeeRecipients
    seadrop-public-->>wizard: mintPublic calldata（各钱包相同）
    wizard->>local-mint: 预签名所有交易
    local-mint->>rpc-blast: T-0 向全部 RPC 并发 eth_sendRawTransaction
    rpc-blast-->>User: 本地 txHash 立即返回，异步收响应/回执
```

## 重大架构决策
完整的ADR存储在各变更的how.md中，本章节提供索引。

| adr_id | title | date | status | affected_modules | details |
|--------|-------|------|--------|------------------|---------|
| ADR-1 | 文案中文化但不改时区语义（保留 UTC+7） | 2026-09-14 | ✅已采纳 | 全部模块 | [history/2026-09/202609141442_zh-cn-i18n/how.md](../history/2026-09/202609141442_zh-cn-i18n/how.md) |