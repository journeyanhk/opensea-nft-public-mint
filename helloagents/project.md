# 项目技术约定

---

## 技术栈
- **核心:** TypeScript 5.3 / Node.js 18+ / ethers 6 / chalk 4 / dotenv / ora
- **测试:** node:test（CJS 脚本，`node --test tests/`）

---

## 开发约定
- **代码规范:** 严格模式 TS；无额外注释（按仓库现状）
- **命名约定:** camelCase；链 key 为小写（ethereum/base/robinhood）
- **时间约定:** 全部 UI 时间按越南时间 UTC+7 展示（`src/time-format.ts`），文案已中文化但时区语义保持 UTC+7

---

## 错误与日志
- **策略:** 错误直接 throw，入口 `src/index.ts` 统一输出 `❌ {message}`
- **日志:** chalk 彩色分级（绿=成功、黄=警告、红=错误、灰=细节）

---

## 测试与流程
- **测试:** `npm run build` 后 `node --test tests/`
- **提交:** 英文简洁提交信息（沿用仓库风格）