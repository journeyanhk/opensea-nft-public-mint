// Best-effort JSON cache for audit scans.
//
// A few hundred drops and a few thousand events sit far below the point where a
// database pays for itself, and an on-disk cache keeps the audit usable when the
// same target is checked twice in a row (CLI then batch, or two wallets).

import fs from "fs";
import path from "path";

export interface CacheEnvelope<T> {
  scannedToBlock: number;
  scannedAt: number; // epoch ms
  data: T;
}

export const DEFAULT_CACHE_DIR = path.resolve(process.cwd(), ".audit-cache");

export function cachePath(chainKey: string, contract: string, dir = DEFAULT_CACHE_DIR): string {
  return path.join(dir, chainKey, `${contract.toLowerCase()}.json`);
}

export function readCache<T>(chainKey: string, contract: string, dir = DEFAULT_CACHE_DIR): CacheEnvelope<T> | null {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath(chainKey, contract, dir), "utf8"));
    if (typeof raw?.scannedToBlock !== "number" || typeof raw?.scannedAt !== "number" || raw.data === undefined) {
      return null;
    }
    return raw as CacheEnvelope<T>;
  } catch {
    return null;
  }
}

// Never let a read-only cache failure break an audit.
export function writeCache<T>(
  chainKey: string,
  contract: string,
  envelope: CacheEnvelope<T>,
  dir = DEFAULT_CACHE_DIR
): void {
  try {
    const file = cachePath(chainKey, contract, dir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(envelope));
  } catch {
    // ignore
  }
}

export function isFresh(envelope: CacheEnvelope<unknown>, ttlMs: number): boolean {
  return Date.now() - envelope.scannedAt < ttlMs;
}
