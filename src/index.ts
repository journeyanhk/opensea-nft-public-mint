#!/usr/bin/env node

import path from "path";
import dotenv from "dotenv";
import chalk from "chalk";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

import { runWizard } from "./wizard";
import { closePrompts } from "./prompt";
import { runAllowlistWizard } from "./allowlist";

const HELP = `
NFT Public Mint Sniper

  在输入 OpenSea 链接/slug 且配置了 OPENSEA_API_KEY 时，
  自动识别正在进行的 Allowlist/WL FCFS 轮次。Public 使用链上数据。

用法
  npm start              在向导中自动识别 mint 轮次
  npm start -- --help    显示此帮助
  npm start -- --check-allowlist  检查钱包在当前 Allowlist 轮次的资格，无需私钥
  npm start -- --allowlist        检查并 mint 当前 Allowlist/WL FCFS 轮次

程序会依次询问私钥、链、数量、NFT 链接、RPC、gas 和 mint 时间。
可在 .env 中设置默认值（见 .env.example）。
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    return;
  }

  try {
    if (args.includes("--check-allowlist") || args.includes("--allowlist")) {
      await runAllowlistWizard(args.includes("--check-allowlist"));
    } else {
      await runWizard();
    }
    closePrompts();
    process.exit(0);
  } catch (err: any) {
    closePrompts();
    console.error(chalk.red(`\n❌ ${err.message}\n`));
    process.exit(1);
  }
}

void main();
