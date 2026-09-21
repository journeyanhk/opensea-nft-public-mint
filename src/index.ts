#!/usr/bin/env node

import path from "path";
import fs from "fs";
import dotenv from "dotenv";
import chalk from "chalk";

import { runWizard } from "./wizard";
import { closePrompts } from "./prompt";
import { runAllowlistWizard } from "./allowlist";
import { BatchRunOptions, runBatch } from "./batch-runner";
import { runAuditCommand } from "./audit/cli";
import { runScanCommand } from "./scan/cli";
import { runBackfillCommand } from "./scan/backfill-cli";
import { runRefreshCommand } from "./scan/refresh";
import { assertNoPrivateKeys, serveConfig } from "./serve/config";
import { runServe } from "./serve/server";

const KNOWN_FLAGS = new Set([
  "--help", "-h",
  "--check-allowlist", "--allowlist",
  "--batch", "--watch", "--watch-interval", "--no-ledger", "--retry-pending",
  "--audit", "--chain", "--wallets", "--lookback-days", "--quantity", "--max-price", "--grade",
  "--export", "--force", "--json",
  "--scan", "--since-days", "--horizon-hours", "--limit", "--no-audit", "--include-mints",
  "--report", "--state", "--history", "--ledger", "--backfill-file",
  "--backfill", "--backfill-after",
  "--refresh-targets",
  "--serve",
  "--export-favorites",
  "--favorites",
  "--dry-run",
  "--burst-count", "--burst-spacing-ms", "--burst-lead-ms", "--allow-overshoot", "--force-clock",
  "--parallel",
  "--executor", "--queue-dir", "--interval-ms", "--once", "--rotate-arm-token",
]);

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
      --watch [file...]           keep re-reading the config(s) and merge new targets into the queue
      --watch-interval <seconds>  poll interval for --watch (default 60)
      --no-ledger                 disable the .batch-state.json guard against sending twice
      --retry-pending             re-send targets whose ledger entry never got an outcome
  npm start -- --audit <target...> [--chain <key>] [--wallets 0x..,0x..] [--export <file> [--force]] [--grade A,B]
                                  check supply, mint curve and late changes before queueing; read-only
  npm start -- --scan [--chain robinhood,arc] [--since-days 1] [--horizon-hours 72] [--limit 20] [--export <file>]
                                  discover new drops on-chain, audit the candidates; incremental cursor in .scan-state.json
  npm start -- --backfill [--ledger <file>] [--backfill-after 24,72] [--backfill-file <file>]
                                  settle cost and floor-price checkpoints for minted targets; idempotent
  npm start -- --executor [--queue-dir <dir>] [--interval-ms N] [--once] [--dry-run]
                                  drain the execution queue written by the panel
                                  (loads .env.executor, refuses to start without keys)
  npm start -- --batch <file> --dry-run
                                  sign and simulate every transaction, broadcast nothing (no ledger writes)
  npm start -- --export-favorites [<file.jsonl>] [--favorites <file>]
                                  dump every favorite with the signals seen when it was starred (analysis input)
  npm start -- --refresh-targets [--limit N] [--chain <key>] [--state <file>]
                                  resolve slugs/names/owner and read collections (socials, image) for the state file
                                  (run until "all entries"); set ENABLE_X_METRICS=1 to also cache X follower counts
  npm start -- --serve            run the scanner/backfill scheduler and the dashboard over http (read-only)
                                  loads .env.serve (never .env) and refuses to start with private keys present
      --report <out.html>         also write a static dashboard from .scan-state.json, .scan-history.jsonl
                                  and .batch-state.json (works alone, or after --scan)
      --state/--history/--ledger  override the input files for --report

The program will ask for private keys, chain, quantity, NFT link, RPC,
gas and mint time in order. Defaults can be set in .env (see .env.example).
Batch mode reads its targets from the given JSON file and takes gas, RPC and
keys from .env unless the file overrides them.
Audit mode takes a chain from the link or --chain; @file expands one target per line.
`;

function parallelLimitOf(args: string[]): number | undefined {
  const index = args.indexOf("--parallel");
  if (index < 0) return undefined;
  const value = Number(args[index + 1]);
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : undefined;
}

function burstOverrides(args: string[]): BatchRunOptions["burst"] {
  const flagNumber = (flag: string): number | undefined => {
    const index = args.indexOf(flag);
    if (index < 0) return undefined;
    const value = Number(args[index + 1]);
    return Number.isFinite(value) ? value : undefined;
  };
  const count = flagNumber("--burst-count");
  const spacingMs = flagNumber("--burst-spacing-ms");
  const leadRaw = args.indexOf("--burst-lead-ms") >= 0 ? args[args.indexOf("--burst-lead-ms") + 1] : undefined;
  const leadMs =
    leadRaw === "auto" ? ("auto" as const) : leadRaw !== undefined && Number.isFinite(Number(leadRaw)) ? Number(leadRaw) : undefined;
  const overshoot = args.includes("--allow-overshoot");
  const forceClock = args.includes("--force-clock");
  if (count === undefined && spacingMs === undefined && leadMs === undefined && !overshoot && !forceClock) return undefined;
  return {
    ...(count !== undefined ? { count } : {}),
    ...(spacingMs !== undefined ? { spacingMs } : {}),
    ...(leadMs !== undefined ? { leadMs } : {}),
    ...(overshoot ? { allowOvershoot: true } : {}),
    ...(forceClock ? { forceClock: true } : {}),
  };
}

function batchRunOptions(args: string[]): BatchRunOptions {
  const watchIndex = args.indexOf("--watch");
  const watchFiles: string[] = [];
  if (watchIndex >= 0) {
    for (let i = watchIndex + 1; i < args.length && !args[i].startsWith("--"); i++) {
      watchFiles.push(args[i]);
    }
  }
  const intervalIndex = args.indexOf("--watch-interval");
  const seconds = intervalIndex >= 0 ? Number(args[intervalIndex + 1]) : NaN;
  return {
    watch: watchIndex >= 0,
    watchFiles,
    watchIntervalMs: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : undefined,
    ledger: !args.includes("--no-ledger"),
    retryPending: args.includes("--retry-pending"),
    dryRun: args.includes("--dry-run"),
    burst: burstOverrides(args),
    parallel: args.includes("--parallel"),
    parallelLimit: parallelLimitOf(args),
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    return;
  }

  // Serve mode is physically separated from key material: it loads .env.serve
  // (or the process environment) and refuses to run if a private key is present.
  const serve = args.includes("--serve");
  const executor = args.includes("--executor");
  if (serve) {
    dotenv.config({ path: process.env.SERVE_ENV_FILE ?? path.resolve(process.cwd(), ".env.serve") });
  } else if (executor) {
    // The executor is the only process that holds keys and drains the queue.
    dotenv.config({ path: process.env.EXECUTOR_ENV_FILE ?? path.resolve(process.cwd(), ".env.executor") });
  } else {
    dotenv.config({ path: path.resolve(process.cwd(), ".env") });
  }

  try {
    // A flag this build does not know (usually a stale dist after git pull)
    // must fail loudly instead of silently falling through to the wizard.
    const unknown = args.filter((arg) => arg.startsWith("--") && !KNOWN_FLAGS.has(arg));
    if (unknown.length > 0) {
      throw new Error(
        `Unknown option ${unknown.join(", ")} — if this flag is new, run "npm run build" after "git pull".`
      );
    }

    if (serve) {
      assertNoPrivateKeys();
      await runServe(serveConfig());
      closePrompts();
      process.exit(0);
    }
    const batchIndex = args.indexOf("--batch");
    if (args.includes("--audit")) {
      await runAuditCommand(args);
    } else if (args.includes("--executor")) {
      const { runExecutor } = await import("./executor/run");
      const value = (flag: string): string | undefined => {
        const index = args.indexOf(flag);
        return index >= 0 ? args[index + 1] : undefined;
      };
      await runExecutor({
        queueDir: value("--queue-dir"),
        ledgerPath: value("--ledger"),
        intervalMs: Number(value("--interval-ms")) || undefined,
        once: args.includes("--once"),
        dryRun: args.includes("--dry-run"),
        rotateArmToken: args.includes("--rotate-arm-token"),
      });
    } else if (args.includes("--export-favorites")) {
      const { runExportFavoritesCommand } = await import("./scan/favorites-cli");
      await runExportFavoritesCommand(args);
    } else if (args.includes("--refresh-targets")) {
      await runRefreshCommand(args);
    } else if (args.includes("--backfill")) {
      await runBackfillCommand(args);
    } else if (args.includes("--scan") || args.includes("--report")) {
      await runScanCommand(args);
    } else if (batchIndex >= 0) {
      const options = batchRunOptions(args);
      let configFile =
        args[batchIndex + 1] && !args[batchIndex + 1].startsWith("--") ? args[batchIndex + 1] : "targets.json";
      // `--batch --watch targets.scan.robinhood.json` is a natural invocation:
      // fall back to the first watched file when the default config is absent.
      if (!fs.existsSync(configFile) && options.watchFiles && options.watchFiles.length > 0) {
        const [first, ...rest] = options.watchFiles;
        if (fs.existsSync(first)) {
          configFile = first;
          options.watchFiles = rest;
        }
      }
      await runBatch(configFile, options);
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
