#!/usr/bin/env node

import path from "path";
import dotenv from "dotenv";
import chalk from "chalk";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

import { runWizard } from "./wizard";
import { closePrompts } from "./prompt";
import { runAllowlistWizard } from "./allowlist";
import { runBatch } from "./batch-runner";
import { runAuditCommand } from "./audit/cli";
import { runScanCommand } from "./scan/cli";

const HELP = `
NFT Public Mint Sniper

  Auto-detects a live Allowlist/WL FCFS stage when an OpenSea link/slug
  is entered and OPENSEA_API_KEY is set. Public uses on-chain data.

Usage
  npm start              auto-detect the mint stage in the wizard
  npm start -- --help    show this help
  npm start -- --check-allowlist  check wallet eligibility for a live Allowlist stage, no private key needed
  npm start -- --allowlist        check and mint a live Allowlist/WL FCFS stage
  npm start -- --batch <file>     run several public mints in start-time order, unattended (default file: targets.json)
  npm start -- --audit <target...> [--chain <key>] [--wallets 0x..,0x..] [--export <file> [--force]] [--grade A,B]
                                  check supply, mint curve and late changes before queueing; read-only
  npm start -- --scan [--chain robinhood,arc] [--since-days 1] [--horizon-hours 72] [--limit 20] [--export <file>]
                                  discover new drops on-chain, audit the candidates; incremental cursor in .scan-state.json

The program will ask for private keys, chain, quantity, NFT link, RPC,
gas and mint time in order. Defaults can be set in .env (see .env.example).
Batch mode reads its targets from the given JSON file and takes gas, RPC and
keys from .env unless the file overrides them.
Audit mode takes a chain from the link or --chain; @file expands one target per line.
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    return;
  }

  try {
    const batchIndex = args.indexOf("--batch");
    if (args.includes("--audit")) {
      await runAuditCommand(args);
    } else if (args.includes("--scan")) {
      await runScanCommand(args);
    } else if (batchIndex >= 0) {
      await runBatch(args[batchIndex + 1] ?? "targets.json");
    } else if (args.includes("--check-allowlist") || args.includes("--allowlist")) {
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
