// Execution ledger: the only thing standing between a restarted --watch batch
// and minting the same drop twice.
//
// Written before the send (PENDING) and updated with the outcome, so a crash
// between broadcast and receipt leaves a record that says "something may have
// hit the chain". Plain JSON, atomic write, no native dependency.

import fs from "fs";
import path from "path";
import { SnipeStatus } from "./local-mint";

export const DEFAULT_LEDGER_PATH = path.resolve(process.cwd(), ".batch-state.json");

export type LedgerStatus = SnipeStatus | "PENDING";

export interface LedgerEntry {
  status: LedgerStatus;
  txHash: string | null;
  at: string;
  quantity: number;
  slug: string | null; // original config input, reused by backfill
}

export interface Ledger {
  version: 1;
  entries: Record<string, Record<string, LedgerEntry>>;
}

export function emptyLedger(): Ledger {
  return { version: 1, entries: {} };
}

export function loadLedger(file = DEFAULT_LEDGER_PATH): Ledger {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (raw?.version !== 1 || typeof raw.entries !== "object") return emptyLedger();
    return raw as Ledger;
  } catch {
    return emptyLedger();
  }
}

export function saveLedger(ledger: Ledger, file = DEFAULT_LEDGER_PATH): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2));
  fs.renameSync(tmp, file);
}

export function recordEntry(
  ledger: Ledger,
  chainKey: string,
  contract: string,
  entry: LedgerEntry
): void {
  const perChain = (ledger.entries[chainKey] ??= {});
  perChain[contract.toLowerCase()] = entry;
}

export function entryOf(ledger: Ledger, chainKey: string, contract: string): LedgerEntry | undefined {
  return ledger.entries[chainKey]?.[contract.toLowerCase()];
}

// Anything that may have reached the chain must not be sent again. SKIPPED and
// REJECTED never hit the chain, so those are allowed to retry.
export function shouldSkipLedger(
  entry: LedgerEntry | undefined,
  opts: { retryPending?: boolean } = {}
): boolean {
  if (!entry) return false;
  if (entry.txHash !== null) return true;
  if (entry.status === "SUCCESS" || entry.status === "REVERTED" || entry.status === "TIMEOUT") return true;
  if (entry.status === "PENDING") return !opts.retryPending;
  return false;
}
