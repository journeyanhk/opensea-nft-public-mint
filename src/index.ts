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

  Tự nhận diện vòng Allowlist/WL FCFS đang mở khi nhập link/slug OpenSea
  và có OPENSEA_API_KEY. Public sử dụng dữ liệu on-chain.

Sử dụng
  npm start              tự nhận diện vòng mint trong trình hướng dẫn
  npm start -- --help    hiển thị trợ giúp này
  npm start -- --check-allowlist  kiểm tra ví ở vòng Allowlist đang mở, không cần private key
  npm start -- --allowlist        kiểm tra và mint Allowlist/WL FCFS đang mở

Chương trình sẽ lần lượt hỏi private key, chain, số lượng, liên kết NFT, RPC,
gas và thời điểm mint. Có thể đặt giá trị mặc định trong .env (xem .env.example).
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
