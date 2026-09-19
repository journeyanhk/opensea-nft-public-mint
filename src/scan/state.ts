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
  lastMintedTotal: string | null; // totalMinted at the previous audit (velocity series)
  quietStreak: number; // consecutive audits with no new mints; slows re-audits down
  slug: string | null; // OpenSea collection slug; resolves once and never changes
  name: string | null; // token name()
  endTime: number | null; // public drop end, unix seconds
  maxSupply: string | null; // getMintStats max, as a string to stay JSON-safe
  totalMinted: string | null; // cumulative minted at the last read
  // M5b: identity and creator history. All optional-on-read so pre-M5b state
  // files keep loading; `undefined` is treated like `null`.
  owner: string | null; // contract owner() / deployer
  imageUrl: string | null; // collection image (whitelisted at render time)
  twitter: string | null; // handle, not a URL
  discord: string | null; // invite URL
  website: string | null; // project URL
  createdDate: string | null; // collection creation date, ISO
  safelist: string | null; // OpenSea safelist status
  socialCheckedAt: string | null; // when collections was last read (null = never)
  xFollowers: number | null; // opt-in X follower count
  xCheckedAt: string | null; // when X metrics were last read
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

export function emptyContractEntry(): ContractEntry {
  return {
    firstSeenBlock: 0,
    lastSeenBlock: 0,
    lastAuditedBlock: null,
    lastAuditedAt: null,
    lastGrade: null,
    soldOutAtBlock: null,
    publicStart: null,
    pendingAudit: false,
    lastMintedTotal: null,
    quietStreak: 0,
    slug: null,
    name: null,
    endTime: null,
    maxSupply: null,
    totalMinted: null,
    owner: null,
    imageUrl: null,
    twitter: null,
    discord: null,
    website: null,
    createdDate: null,
    safelist: null,
    socialCheckedAt: null,
    xFollowers: null,
    xCheckedAt: null,
  };
}

export function saveState(state: ScanState, file = DEFAULT_STATE_PATH): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

// A refresh must never clobber what a concurrent scan wrote while it worked.
// Instead of writing its whole in-memory snapshot back, it writes only the
// fields it actually refreshed, re-reading and merging the file first, so
// contracts discovered meanwhile and the scan cursors survive.
export interface StatePatch {
  contracts: Record<string, Record<string, Partial<ContractEntry>>>;
}

export function saveStateMerged(patch: StatePatch, file = DEFAULT_STATE_PATH): void {
  const { state } = loadState(file);
  for (const [chain, contracts] of Object.entries(patch.contracts)) {
    const known = (state.contracts[chain] ??= {});
    for (const [contract, fields] of Object.entries(contracts)) {
      const key = contract.toLowerCase();
      known[key] = { ...(known[key] ?? emptyContractEntry()), ...fields };
    }
  }
  saveState(state, file);
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
      known[key] = { ...emptyContractEntry(), firstSeenBlock: block, lastSeenBlock: block };
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
