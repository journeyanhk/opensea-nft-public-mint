// Auto-derived "smart minters": no hand-maintained address list.
//
// When a drop sells out, the wallets that filled the per-wallet cap (or minted
// repeatedly) are the ones that actually won. When the same wallet shows up in
// a second sold-out drop it stops being noise; when several of them touch a
// target during its presale that is the strongest demand signal we can get
// before the public sale opens.
//
// This is deliberately the minting side only: Seaport buy/sell and transfer
// classification is a different, larger problem.

import fs from "fs";
import path from "path";

export const DEFAULT_SMART_PATH = path.resolve(process.cwd(), ".smart-minters.json");
const QUALIFY_APPEARANCES = 2;
const STORE_LIMIT = 5000;

export interface SmartMinterRecord {
  appearances: number;
  drops: string[]; // `chain|contract`, deduped
}

export interface SmartStore {
  version: 1;
  updatedAt: string | null;
  minters: Record<string, SmartMinterRecord>;
}

export interface MinterTokens {
  address: string;
  tokens: bigint;
}

export function emptySmartStore(): SmartStore {
  return { version: 1, updatedAt: null, minters: {} };
}

export function loadSmartStore(file = DEFAULT_SMART_PATH): SmartStore {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (raw?.version !== 1 || typeof raw.minters !== "object" || raw.minters === null) return emptySmartStore();
    return raw as SmartStore;
  } catch {
    return emptySmartStore();
  }
}

export function saveSmartStore(store: SmartStore, file = DEFAULT_SMART_PATH): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, file);
}

// A wallet counts when it filled the per-wallet cap (known) or minted at least
// three times (cap unknown) — one-off minters are not a signal.
export function smartCandidates(walletMints: MinterTokens[], capPerWallet: number | null): string[] {
  const threshold = capPerWallet !== null && capPerWallet >= 1 ? BigInt(capPerWallet) : 3n;
  return walletMints
    .filter((wallet) => wallet.tokens >= threshold)
    .map((wallet) => wallet.address.toLowerCase())
    .sort();
}

export function addSmartCandidates(store: SmartStore, addresses: string[], target: string, at: string): number {
  for (const address of addresses) {
    const key = address.toLowerCase();
    const record = (store.minters[key] ??= { appearances: 0, drops: [] });
    record.appearances++;
    if (!record.drops.includes(target)) record.drops.push(target);
  }
  store.updatedAt = at;

  // Keep the store bounded: the least-seen wallets are the first to go.
  const keys = Object.keys(store.minters);
  if (keys.length > STORE_LIMIT) {
    keys
      .sort((a, b) => store.minters[a].appearances - store.minters[b].appearances || a.localeCompare(b))
      .slice(0, keys.length - STORE_LIMIT)
      .forEach((key) => delete store.minters[key]);
  }
  return addresses.length;
}

export function smartSet(store: SmartStore, minAppearances = QUALIFY_APPEARANCES): Set<string> {
  return new Set(
    Object.entries(store.minters)
      .filter(([, record]) => record.appearances >= minAppearances)
      .map(([address]) => address)
  );
}

export function smartOverlap(walletMints: MinterTokens[], set: Set<string>): number {
  let count = 0;
  for (const wallet of walletMints) {
    if (set.has(wallet.address.toLowerCase())) count++;
  }
  return count;
}
