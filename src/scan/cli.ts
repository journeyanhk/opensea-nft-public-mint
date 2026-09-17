// `--scan` command: find new drops, filter them, audit the survivors.
//
// Intended to run unattended on a timer; the incremental path costs a handful of
// RPC calls per run, so every 10-30 minutes is cheap.

import fs from "fs";
import chalk from "chalk";
import { Grade } from "../audit/score";
import { DEFAULT_LEDGER_PATH, loadLedger } from "../batch-ledger";
import { DEFAULT_HISTORY_PATH, DEFAULT_STATE_PATH, loadState } from "./state";
import { loadDashboardRows, loadHistory, renderDashboard } from "./html";
import { exportByChain, renderAuditDetail, renderAuditTable, renderJson } from "../audit/report";
import { DEFAULT_SCAN_CHAINS, runScan } from "./scanner";

interface Args {
  scan: boolean;
  reportPath: string | null;
  statePath: string;
  historyPath: string;
  ledgerPath: string;
  chains: string[];
  sinceDays: number;
  horizonHours: number;
  limit: number;
  lookbackDays: number;
  grades: Grade[];
  exportPath: string | null;
  force: boolean;
  quantity: number;
  maxPrice: string | "current";
  json: boolean;
  audit: boolean;
  includeMints: boolean;
}

const VALID_GRADES: Grade[] = ["A", "B", "C", "D"];

export function parseScanArgs(args: string[]): Args {
  const marker = args.includes("--scan") ? args.indexOf("--scan") : args.indexOf("--report");
  if (marker < 0) throw new Error("--report needs the flag itself (--scan --report <file> or --report <file>)");
  const rest = args.slice(marker + 1);
  const parsed: Args = {
    scan: args.includes("--scan"),
    reportPath: null,
    statePath: process.env.SCAN_STATE_PATH ?? DEFAULT_STATE_PATH,
    historyPath: process.env.SCAN_HISTORY_PATH ?? DEFAULT_HISTORY_PATH,
    ledgerPath: process.env.BATCH_LEDGER_PATH ?? DEFAULT_LEDGER_PATH,
    chains: [],
    sinceDays: 1,
    horizonHours: 72,
    limit: 20,
    lookbackDays: 0.5,
    grades: ["A", "B"],
    exportPath: null,
    force: false,
    quantity: 1,
    maxPrice: "current",
    json: false,
    audit: true,
    includeMints: false,
  };

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--json") parsed.json = true;
    else if (arg === "--no-audit") parsed.audit = false;
    else if (arg === "--include-mints") parsed.includeMints = true;
    else if (arg === "--force") parsed.force = true;
    else if (arg === "--chain") parsed.chains.push(...(rest[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean));
    else if (arg === "--since-days") parsed.sinceDays = Math.max(0.01, Number(rest[++i] ?? "1") || 1);
    else if (arg === "--horizon-hours") parsed.horizonHours = Math.max(1, Number(rest[++i] ?? "72") || 72);
    else if (arg === "--limit") parsed.limit = Math.max(1, parseInt(rest[++i] ?? "20", 10) || 20);
    else if (arg === "--lookback-days") parsed.lookbackDays = Math.max(0.05, Number(rest[++i] ?? "0.5") || 0.5);
    else if (arg === "--export") parsed.exportPath = rest[++i] ?? "targets.scan.json";
    else if (arg === "--report") parsed.reportPath = rest[++i] ?? "dashboard.html";
    else if (arg === "--state") parsed.statePath = rest[++i] ?? parsed.statePath;
    else if (arg === "--history") parsed.historyPath = rest[++i] ?? parsed.historyPath;
    else if (arg === "--ledger") parsed.ledgerPath = rest[++i] ?? parsed.ledgerPath;
    else if (arg === "--quantity") parsed.quantity = Math.max(1, parseInt(rest[++i] ?? "1", 10) || 1);
    else if (arg === "--max-price") parsed.maxPrice = rest[++i] ?? "current";
    else if (arg === "--grade") {
      parsed.grades = (rest[++i] ?? "A,B")
        .split(",")
        .map((g) => g.trim().toUpperCase())
        .filter((g): g is Grade => VALID_GRADES.includes(g as Grade));
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option "${arg}"`);
    } else if (!parsed.scan && parsed.reportPath === null) {
      // `--report dashboard.html` slices the path in as a positional.
      parsed.reportPath = arg;
    } else {
      throw new Error(`Unexpected argument "${arg}"`);
    }
  }

  if (parsed.chains.length === 0) parsed.chains = [...DEFAULT_SCAN_CHAINS];
  return parsed;
}

function writeDashboard(parsed: Args): void {
  const { state } = loadState(parsed.statePath);
  const rows = loadDashboardRows(state, loadHistory(parsed.historyPath), loadLedger(parsed.ledgerPath));
  if (rows.length === 0) {
    throw new Error(`No targets in ${parsed.statePath} — run --scan first.`);
  }
  const html = renderDashboard(rows, {
    generatedAt: new Date().toISOString(),
    sources: [parsed.statePath, parsed.historyPath, parsed.ledgerPath],
  });
  fs.writeFileSync(parsed.reportPath!, html);
  console.log(chalk.bold(`\nDashboard: ${parsed.reportPath} (${rows.length} target(s))`));
  console.log(chalk.gray(`  open ${parsed.reportPath}`));
}

export async function runScanCommand(args: string[]): Promise<void> {
  const parsed = parseScanArgs(args);
  if (!parsed.scan) {
    writeDashboard(parsed);
    return;
  }

  const reports = await runScan(
    {
      chains: parsed.chains,
      includeMints: parsed.includeMints,
      sinceDays: parsed.sinceDays,
      horizonHours: parsed.horizonHours,
      limit: parsed.limit,
      lookbackDays: parsed.lookbackDays,
      audit: parsed.audit,
    },
    (message) => console.log(chalk.gray(`  ${message}`))
  );

  console.log("");
  for (const report of reports) {
    const skipped = report.skipped;
    console.log(
      chalk.bold(
        `${report.chainKey}: blocks ${report.fromBlock}..${report.toBlock} (${report.windows} windows) | ` +
          `discovered ${report.discovered} new ${report.newContracts.length} | candidates ${report.candidates.length} | ` +
          `audited ${report.audited.length}`
      )
    );
    console.log(
      chalk.gray(
        `  skipped: ended ${skipped.ended}, beyond horizon ${skipped.far}, sold out ${skipped.soldOut}, ` +
          `not applicable ${skipped.notApplicable}, unchanged ${skipped.known}, over limit ${skipped.limited}`
      )
    );
  }

  const audited = reports.flatMap((r) => r.audited);
  if (audited.length > 0) {
    const counts = audited.reduce<Record<string, number>>((acc, r) => {
      acc[r.grade.grade] = (acc[r.grade.grade] ?? 0) + 1;
      return acc;
    }, {});
    console.log(
      chalk.bold(
        `\nGrades: ${["A", "B", "C", "D"].map((g) => `${g} ${counts[g] ?? 0}`).join(" | ")}`
      )
    );
    if (parsed.json) console.log(renderJson(audited));
    else {
      console.log("");
      console.log(renderAuditTable(audited));
      console.log(renderAuditDetail(audited));
    }
  }

  if (parsed.reportPath) writeDashboard(parsed);

  if (parsed.exportPath) {
    const exported = await exportByChain(audited, {
      path: parsed.exportPath,
      quantity: parsed.quantity,
      maxPriceEth: parsed.maxPrice,
      grades: parsed.grades,
      force: parsed.force,
    });
    for (const file of exported) {
      console.log(chalk.bold(`\nExported ${file.accepted} target(s) to ${file.path}`));
      for (const line of file.schedule) console.log(chalk.gray(line));
      for (const reject of file.rejected) console.log(chalk.red(`  rejected ${reject.target}: ${reject.reason}`));
    }
  }
}
