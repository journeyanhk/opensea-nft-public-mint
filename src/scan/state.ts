// Scan state: a cursor per chain plus per-contract discovery/audit facts.
//
// Plain JSON written atomically (temp file + rename) so a crash mid-scan cannot
// corrupt it, and a JSONL history that only ever grows. No native dependency.

import fs from "fs";
import path from "path";
import { Grade } from "../audit/score";

export const DEFAULT_STATE_PATH = path.resolve(process.cwd(), ".scan-state.json");
export const DEFAULT_HISTORY_PATH = path.resolve(process.cwd(), ".scan-history.jsonl");

export interface ChainCursor {
  cursorBlock: number;
  blockTimeSec: number;
  updatedAt: string;
}

export interface ContractEntry {
  firstSeenBlock: number;
  lastSeenBlock: number;
  lastAuditedBlock: number | null;
  lastAuditedAt: string | null;
  lastGrade: Grade | null;
  soldOutAtBlock: number | null;
  publicStart: number | null; // unix seconds, latest known
  pendingAudit: boolean; // was a candidate but beyond --limit; audited first next run
}

export interface ScanState {
  version: 1;
  chains: Record<string, ChainCursor>;
  contracts: Record<string, Record<string, ContractEntry>>;
}

export function emptyState(): ScanState {
  return { version: 1, chains: {}, contracts: {} };
}

export function loadState(file = DEFAULT_STATE_PATH): { state: ScanState; corrupt: boolean } {
  if (!fs.existsSync(file)) return { state: emptyState(), corrupt: false };
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (raw?.version !== 1 || typeof raw.chains !== "object" || typeof raw.contracts !== "object") {
      return { state: emptyState(), corrupt: true };
    }
    return { state: raw as ScanState, corrupt: false };
  } catch {
    return { state: emptyState(), corrupt: true };
  }
}

export function saveState(state: ScanState, file = DEFAULT_STATE_PATH): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

export function appendHistory(records: unknown[], file = DEFAULT_HISTORY_PATH): void {
  if (records.length === 0) return;
  try {
    fs.appendFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  } catch {
    // history is a convenience; never fail a scan over it
  }
}

// New contracts are returned so the caller can report them; known contracts only
// have their last-seen block moved forward.
export function recordContracts(
  state: ScanState,
  chainKey: string,
  contracts: { contract: string; block: number }[],
  _at: string
): string[] {
  const known = (state.contracts[chainKey] ??= {});
  const newest = new Map<string, number>();
  for (const { contract, block } of contracts) {
    const key = contract.toLowerCase();
    newest.set(key, Math.max(newest.get(key) ?? 0, block));
  }

  const added: string[] = [];
  for (const [key, block] of newest) {
    const entry = known[key];
    if (!entry) {
      known[key] = {
        firstSeenBlock: block,
        lastSeenBlock: block,
        lastAuditedBlock: null,
        lastAuditedAt: null,
        lastGrade: null,
        soldOutAtBlock: null,
        publicStart: null,
        pendingAudit: false,
      };
      added.push(key);
    } else {
      entry.lastSeenBlock = Math.max(entry.lastSeenBlock, block);
    }
  }
  return added;
}

export function advanceCursor(
  state: ScanState,
  chainKey: string,
  toBlock: number,
  blockTimeSec: number,
  at: string
): void {
  state.chains[chainKey] = { cursorBlock: toBlock, blockTimeSec, updatedAt: at };
}
