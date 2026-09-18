// Serve-mode configuration, and the guard that keeps key material out of the
// dashboard process.
//
// The dashboard only ever reads the chain and local state files; it must never
// see a private key. `--serve` therefore loads `.env.serve` instead of `.env`
// and refuses to start if key material is present in the environment at all —
// "we don't call the key loader" is not a property that can be audited, an
// empty environment is.

import path from "path";
import { DEFAULT_CACHE_DIR } from "../audit/cache";
import { DEFAULT_HISTORY_PATH, DEFAULT_STATE_PATH } from "../scan/state";
import { DEFAULT_LEDGER_PATH } from "../batch-ledger";
import { DEFAULT_BACKFILL_PATH } from "../scan/backfill";

export interface ServeConfig {
  host: string;
  port: number;
  chains: string[];
  intervalMs: number;
  limit: number;
  lookbackDays: number;
  horizonHours: number;
  includeMints: boolean;
  exportsDir: string;
  statePath: string;
  historyPath: string;
  ledgerPath: string;
  backfillPath: string;
  cacheDir: string;
}

export function assertNoPrivateKeys(env: NodeJS.ProcessEnv = process.env): void {
  const present = ["PRIVATE_KEY", "PRIVATE_KEYS"].filter((name) => (env[name] ?? "").trim().length > 0);
  if (present.length > 0) {
    throw new Error(
      `--serve refuses to run with ${present.join("/")} in the environment — start it with a key-free .env.serve.`
    );
  }
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function serveConfig(env: NodeJS.ProcessEnv = process.env): ServeConfig {
  const chains = (env.SCAN_CHAINS ?? "robinhood,arc")
    .split(",")
    .map((chain) => chain.trim())
    .filter(Boolean);

  return {
    host: (env.SERVE_HOST ?? "").trim() || "127.0.0.1",
    port: Math.floor(positiveNumber(env.SERVE_PORT, 8787)),
    chains: chains.length > 0 ? chains : ["robinhood", "arc"],
    intervalMs: Math.max(60_000, Math.floor(positiveNumber(env.SCAN_INTERVAL_MIN, 15) * 60_000)),
    limit: Math.max(1, Math.floor(positiveNumber(env.SCAN_LIMIT, 20))),
    lookbackDays: positiveNumber(env.SCAN_LOOKBACK_DAYS, 0.5),
    horizonHours: positiveNumber(env.SCAN_HORIZON_HOURS, 72),
    includeMints: env.SCAN_INCLUDE_MINTS === "1" || env.SCAN_INCLUDE_MINTS === "true",
    exportsDir: (env.EXPORTS_DIR ?? "").trim() || path.resolve(process.cwd(), "exports"),
    statePath: (env.SCAN_STATE_PATH ?? "").trim() || DEFAULT_STATE_PATH,
    historyPath: (env.SCAN_HISTORY_PATH ?? "").trim() || DEFAULT_HISTORY_PATH,
    ledgerPath: (env.BATCH_LEDGER_PATH ?? "").trim() || DEFAULT_LEDGER_PATH,
    backfillPath: (env.BACKFILL_PATH ?? "").trim() || DEFAULT_BACKFILL_PATH,
    cacheDir: (env.AUDIT_CACHE_DIR ?? "").trim() || DEFAULT_CACHE_DIR,
  };
}
