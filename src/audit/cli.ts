// `--audit` command: check targets before queueing them for a mint.
//
// Read-only. Prints a table plus per-target detail; `--export` writes a
// targets.<chain>.json that has already round-tripped through loadBatchConfig.

import fs from "fs";
import chalk from "chalk";
import { parseNftLink } from "../nft-link";
import { auditTarget, AuditResult } from "./audit";
import { Grade } from "./score";
import { exportTargets, renderAuditDetail, renderAuditTable, renderJson } from "./report";

interface Args {
  targets: string[];
  wallets: string[];
  lookbackDays: number;
  exportPath: string | null;
  grades: Grade[];
  json: boolean;
  quantity: number;
  maxPrice: string | "current";
  chain: string | null;
  force: boolean;
}

const VALID_GRADES: Grade[] = ["A", "B", "C", "D"];

export function parseAuditArgs(args: string[]): Args {
  const index = args.indexOf("--audit");
  const rest = args.slice(index + 1);
  const parsed: Args = {
    targets: [],
    wallets: [],
    lookbackDays: 7,
    exportPath: null,
    grades: ["A", "B"],
    json: false,
    quantity: 1,
    maxPrice: "current",
    chain: null,
    force: false,
  };

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--json") parsed.json = true;
    else if (arg === "--force") parsed.force = true;
    else if (arg === "--wallets") parsed.wallets = (rest[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (arg === "--lookback-days") parsed.lookbackDays = Math.max(1, Number(rest[++i] ?? "7") || 7);
    else if (arg === "--export") parsed.exportPath = rest[++i] ?? "targets.audit.json";
    else if (arg === "--quantity") parsed.quantity = Math.max(1, parseInt(rest[++i] ?? "1", 10) || 1);
    else if (arg === "--max-price") parsed.maxPrice = rest[++i] ?? "current";
    else if (arg === "--chain") parsed.chain = rest[++i] ?? null;
    else if (arg === "--grade") {
      parsed.grades = (rest[++i] ?? "A,B")
        .split(",")
        .map((g) => g.trim().toUpperCase())
        .filter((g): g is Grade => VALID_GRADES.includes(g as Grade));
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option "${arg}"`);
    } else {
      parsed.targets.push(arg);
    }
  }

  if (parsed.targets.length === 0) throw new Error("--audit needs at least one target (link, slug, address, or @file)");
  return parsed;
}

function expandTargets(targets: string[]): string[] {
  const out: string[] = [];
  for (const target of targets) {
    if (!target.startsWith("@")) {
      out.push(target);
      continue;
    }
    const file = target.slice(1);
    const lines = fs
      .readFileSync(file, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
    out.push(...lines);
  }
  return out;
}

export async function runAuditCommand(args: string[]): Promise<void> {
  const parsed = parseAuditArgs(args);
  const targets = expandTargets(parsed.targets);

  const results: AuditResult[] = [];
  for (const target of targets) {
    const hint = parseNftLink(target).chainHint ?? null;
    const chainKey = parsed.chain ?? hint;
    if (!chainKey) {
      throw new Error(`Cannot tell which chain "${target}" is on — pass --chain (ethereum/base/robinhood/arc).`);
    }
    console.log(chalk.bold(`\nAuditing ${target} on ${chainKey}...`));
    const result = await auditTarget(
      { chainKey, target },
      {
        wallets: parsed.wallets,
        requestedQuantity: parsed.quantity,
        lookbackDays: parsed.lookbackDays,
        onProgress: (message) => console.log(chalk.gray(`  ${message}`)),
      }
    );
    results.push(result);
  }

  if (parsed.json) {
    console.log(renderJson(results));
  } else {
    console.log("");
    console.log(renderAuditTable(results));
    console.log(renderAuditDetail(results));
  }

  if (parsed.exportPath) {
    const byChain = new Map<string, AuditResult[]>();
    for (const result of results) {
      byChain.set(result.chainKey, [...(byChain.get(result.chainKey) ?? []), result]);
    }
    for (const [chainKey, chainResults] of byChain) {
      const path =
        byChain.size === 1
          ? parsed.exportPath
          : parsed.exportPath.replace(/\.json$/i, "") +
            "." +
            chainKey +
            (parsed.exportPath.toLowerCase().endsWith(".json") ? ".json" : "");
      const exported = await exportTargets(chainResults, {
        path,
        chainKey,
        quantity: parsed.quantity,
        maxPriceEth: parsed.maxPrice,
        grades: parsed.grades,
        force: parsed.force,
      });
      console.log(chalk.bold(`\nExported ${exported.accepted} target(s) to ${path}`));
      if (exported.schedule.length > 0) {
        console.log(chalk.gray("BATCH SCHEDULE preview:"));
        for (const line of exported.schedule) console.log(chalk.gray(line));
      }
      for (const reject of exported.rejected) {
        console.log(chalk.red(`  rejected ${reject.target}: ${reject.reason}`));
      }
    }
  }
}
