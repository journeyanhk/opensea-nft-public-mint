// `--backfill` command: settle the +24h/+72h checkpoints for minted targets.
//
// Reads the execution ledger, fetches the mint tx's real cost and (when a key is
// configured) the OpenSea floor, and appends one record per checkpoint. Safe to
// run on a timer: already-recorded checkpoints are skipped.

import chalk from "chalk";
import { DEFAULT_LEDGER_PATH, loadLedger } from "../batch-ledger";
import {
  DEFAULT_BACKFILL_PATH,
  DEFAULT_CHECKPOINTS_HOURS,
  formatNet,
  loadBackfill,
  runBackfill,
} from "./backfill";

interface Args {
  ledgerPath: string;
  file: string;
  horizonsHours: number[];
}

export function parseBackfillArgs(args: string[]): Args {
  const index = args.indexOf("--backfill");
  const rest = args.slice(index + 1);
  const parsed: Args = {
    ledgerPath: DEFAULT_LEDGER_PATH,
    file: DEFAULT_BACKFILL_PATH,
    horizonsHours: [...DEFAULT_CHECKPOINTS_HOURS],
  };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--ledger") parsed.ledgerPath = rest[++i] ?? parsed.ledgerPath;
    else if (arg === "--backfill-file") parsed.file = rest[++i] ?? parsed.file;
    else if (arg === "--backfill-after") {
      const values = (rest[++i] ?? "24,72")
        .split(",")
        .map((v) => Number(v))
        .filter((v) => Number.isFinite(v) && v > 0);
      if (values.length > 0) parsed.horizonsHours = values;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option "${arg}"`);
    }
  }
  return parsed;
}

export async function runBackfillCommand(args: string[]): Promise<void> {
  const parsed = parseBackfillArgs(args);
  const ledger = loadLedger(parsed.ledgerPath);
  console.log(chalk.bold.cyan(`\nBackfill — ledger ${parsed.ledgerPath}`));
  if (!(process.env.OPENSEA_API_KEY || "").trim()) {
    console.log(chalk.yellow("  OPENSEA_API_KEY is not set — costs will be recorded, floor prices skipped"));
  }

  const summary = await runBackfill(ledger, {
    ledgerPath: parsed.ledgerPath,
    file: parsed.file,
    horizonsHours: parsed.horizonsHours,
  });

  if (summary.due === 0) {
    console.log(chalk.gray("  nothing due"));
  } else {
    console.log(
      chalk.gray(
        `  due ${summary.due} | written ${summary.written} | without floor stats ${summary.withoutStats} | records ${parsed.file}`
      )
    );
  }
  for (const error of summary.errors) console.log(chalk.yellow(`  ⚠ ${error}`));

  for (const record of loadBackfill(parsed.file).slice(-5)) {
    console.log(
      chalk.gray(
        `  ${record.chain}/${record.contract} @${record.checkpointHours}h ` +
          `cost ${record.costWei ?? "?"} floor ${record.floorPriceWei ?? "?"} net ${formatNet(record) ?? "?"}`
      )
    );
  }
}
