# NFT Public Mint Sniper

> 本文件包含项目级别的核心信息。详细的模块文档见 `modules/` 目录。

---

## 1. 项目概述

### 目标与背景
OpenSea SeaDrop 公售抢 mint CLI 工具（fork 自 morsyxbt/nft-public-mint）。Public 阶段完全绕过 OpenSea，直接读 SeaDrop 1.0 单例合约拼 calldata、提前签名、开售瞬间多 RPC 并发广播；Allowlist/WL FCFS 阶段走 OpenSea Drops API 取服务端签名，校验并链上模拟后发送。

### 范围
- **范围内:** Ethereum / Base / Robinhood Chain 的 SeaDrop 1.0 单例公售抢 mint；Allowlist/WL FCFS 支持
- **范围外:** 非 SeaDrop 合约、新版 SeaDrop（配置在 token 合约）、非 EVM 链

### 干系人
- **负责人:** 用户（私有 fork 使用）

---

## 2. 模块索引

| 模块名称 | 职责 | 状态 | 文档 |
|---------|------|------|------|
| wizard | 交互向导（私钥/链/数量/NFT/RPC/gas/时机/确认） | 稳定 | [modules/wizard.md](modules/wizard.md) |
| local-mint | 公售本地构造 calldata、预签名、多 RPC 并发广播、回执轮询 | 稳定 | [modules/local-mint.md](modules/local-mint.md) |
| allowlist | OpenSea Drops API 取签名交易、校验、模拟、轮次等待 | 稳定 | [modules/allowlist.md](modules/allowlist.md) |
| rpc | 链注册表、RPC 选择与 chainId 校验 | 稳定 | [modules/rpc.md](modules/rpc.md) |
| keys | .env / CLI 私钥加载与校验 | 稳定 | [modules/keys.md](modules/keys.md) |

---

## 3. 快速链接
- [技术约定](../project.md)
- [架构设计](arch.md)
- [API 手册](api.md)
- [数据模型](data.md)
- [变更历史](../history/index.md)