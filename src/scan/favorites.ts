// Favorites: the user's own judgement, kept as data.
//
// The panel can score "worth it" from signals, but only the human decides what
// to actually watch. Those decisions are also the one labelled dataset we have:
// every favorite records the signals as they looked at the moment it was
// starred, so later — once the ledger and backfill know the outcome — we can
// ask which signals the good calls had in common.
//
// The store is a small JSON file written atomically. It is deliberately
// independent of the scan state: clearing scan data must not lose decisions.

import fs from "fs";
import path from "path";

export const DEFAULT_FAVORITES_PATH = path.resolve(process.cwd(), ".favorites.json");

export type FavoriteStatus = "watching" | "ready" | "dismissed";

export interface FavoriteSnapshot {
  at: string;
  grade: string | null;
  q: number | null;
  confidence: number | null;
  phase: string | null;
  start: number | null;
  mintPriceWei: string | null;
  remaining: string | null;
  maxSupply: string | null;
  minted: string | null;
  velocity24h: string | null;
  uniqueMinters: number | null;
  topMinterShare: number | null;
  smartMinters: number | null;
  batchMint: boolean | null;
  penalties: string[];
  calendarListed: boolean;
  creatorDropCount: number | null;
}

export interface FavoriteRecord {
  chain: string;
  contract: string;
  slug: string | null;
  name: string | null;
  addedAt: string;
  updatedAt: string;
  status: FavoriteStatus;
  note: string;
  snapshot: FavoriteSnapshot | null;
}

export interface FavoritesStore {
  version: 1;
  updatedAt: string | null;
  favorites: Record<string, FavoriteRecord>;
}

export interface FavoriteInput {
  chain: string;
  contract: string;
  slug?: string | null;
  name?: string | null;
  status?: FavoriteStatus;
  note?: string;
  snapshot?: FavoriteSnapshot | null;
}

export function favoriteKey(chain: string, contract: string): string {
  return `${(chain || "").trim().toLowerCase()}|${(contract || "").trim().toLowerCase()}`;
}

export function emptyFavorites(): FavoritesStore {
  return { version: 1, updatedAt: null, favorites: {} };
}

const STATUSES: FavoriteStatus[] = ["watching", "ready", "dismissed"];

function normalizeRecord(raw: unknown, fallbackKey: string): FavoriteRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Partial<FavoriteRecord>;
  const [chain, contract] = fallbackKey.split("|");
  if (!chain || !contract) return null;
  return {
    chain: String(record.chain ?? chain).toLowerCase(),
    contract: String(record.contract ?? contract).toLowerCase(),
    slug: record.slug ?? null,
    name: record.name ?? null,
    addedAt: typeof record.addedAt === "string" ? record.addedAt : new Date().toISOString(),
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : new Date().toISOString(),
    status: STATUSES.includes(record.status as FavoriteStatus) ? (record.status as FavoriteStatus) : "watching",
    note: typeof record.note === "string" ? record.note : "",
    snapshot: record.snapshot ?? null,
  };
}

export function loadFavorites(file = DEFAULT_FAVORITES_PATH): FavoritesStore {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (raw?.version !== 1 || typeof raw.favorites !== "object" || raw.favorites === null) return emptyFavorites();
    const favorites: Record<string, FavoriteRecord> = {};
    for (const [key, value] of Object.entries(raw.favorites as Record<string, unknown>)) {
      const record = normalizeRecord(value, key);
      if (record) favorites[key] = record;
    }
    return { version: 1, updatedAt: raw.updatedAt ?? null, favorites };
  } catch {
    // A missing or unreadable store is empty, never fatal: the board must open.
    return emptyFavorites();
  }
}

export function saveFavorites(store: FavoritesStore, file = DEFAULT_FAVORITES_PATH): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, file);
}

// Only the fields the caller actually provided are touched: editing a note must
// not wipe the snapshot, and re-favoriting must not overwrite the first one.
export function upsertFavorite(store: FavoritesStore, input: FavoriteInput, at: string): FavoriteRecord {
  const key = favoriteKey(input.chain, input.contract);
  const existing = store.favorites[key];
  const record: FavoriteRecord = existing ?? {
    chain: input.chain.trim().toLowerCase(),
    contract: input.contract.trim().toLowerCase(),
    slug: null,
    name: null,
    addedAt: at,
    updatedAt: at,
    status: "watching",
    note: "",
    snapshot: null,
  };

  if (input.slug !== undefined) record.slug = input.slug;
  if (input.name !== undefined) record.name = input.name;
  if (input.status !== undefined) record.status = input.status;
  if (input.note !== undefined) record.note = input.note;
  if (input.snapshot !== undefined && record.snapshot === null) record.snapshot = input.snapshot;
  record.updatedAt = at;

  store.favorites[key] = record;
  store.updatedAt = at;
  return record;
}

export function removeFavorite(store: FavoritesStore, chain: string, contract: string): boolean {
  const key = favoriteKey(chain, contract);
  if (!store.favorites[key]) return false;
  delete store.favorites[key];
  store.updatedAt = new Date().toISOString();
  return true;
}

// One analysis row per favorite, including the snapshot taken when it was
// starred. This is the export that later joins with ledger/backfill outcomes.
export function toJsonl(store: FavoritesStore): string {
  return (
    Object.entries(store.favorites)
      .map(([key, record]) => JSON.stringify({ key, ...record }))
      .join("\n") + (Object.keys(store.favorites).length > 0 ? "\n" : "")
  );
}
