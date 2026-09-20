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

export type LedgerStatus = SnipeStatus | "PARTIAL" | "NO_MINT" | "PENDING";

export interface LedgerEntry {
  status: LedgerStatus;
  txHash: string | null;
  at: string;
  quantity: number;
  slug: string | null; // original config input, reused by backfill
  attempts: number; // sends that were started (PENDING writes)
  // What the receipt proved (M8/B1). Absent on pre-B1 entries.
  mintedCount?: number;
  tokenIds?: string[];
  tokenIdsTruncated?: boolean;
  gasBurnedWei?: string;
  txHashes?: string[]; // every shot of a burst (txHash is the one that landed)
  nonceGap?: boolean;
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

// Anything that may have reached the chain must not be sent again — with one
// deliberate exception: a REVERTED transaction provably minted nothing (a price
// change or a sold-out stage reverts exactly this way), so while the public stage
// is still open it may be retried a couple of times to avoid burning gas forever
// on a target that keeps reverting.
export function shouldSkipLedger(
  entry: LedgerEntry | undefined,
  opts: { retryPending?: boolean; stageOpen?: boolean; maxRevertAttempts?: number } = {}
): boolean {
  if (!entry) return false;
  // PARTIAL and NO_MINT touched the chain just like SUCCESS/TIMEOUT; a NO_MINT
  // in particular must never be resent (the nonce is spent, and a retry is how
  // people pay twice for nothing).
  if (entry.status === "SUCCESS" || entry.status === "TIMEOUT" || entry.status === "PARTIAL" || entry.status === "NO_MINT") {
    return true;
  }
  if (entry.status === "REVERTED") {
    const attempts = entry.attempts ?? 0;
    return !(opts.stageOpen === true && attempts < (opts.maxRevertAttempts ?? 2));
  }
  // Defensive: any other status carrying a hash still touched the chain.
  if (entry.txHash !== null) return true;
  if (entry.status === "PENDING") return !opts.retryPending;
  return false;
}
