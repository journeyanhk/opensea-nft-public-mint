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

  Auto-detects a live Allowlist/WL FCFS stage when an OpenSea link/slug
  is entered and OPENSEA_API_KEY is set. Public uses on-chain data.

Usage
  npm start              auto-detect the mint stage in the wizard
  npm start -- --help    show this help
  npm start -- --check-allowlist  check wallet eligibility for a live Allowlist stage, no private key needed
  npm start -- --allowlist        check and mint a live Allowlist/WL FCFS stage

The program will ask for private keys, chain, quantity, NFT link, RPC,
gas and mint time in order. Defaults can be set in .env (see .env.example).
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
