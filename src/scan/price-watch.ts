// The public terms of a drop can change right up to (and right after) the open:
// a project configures a free mint to climb the free charts and switches to paid
// seconds after it opens. Nothing here reads a whitelist or a signed stage —
// every value comes from SeaDrop's getPublicDrop, which is the public stage.
//
// What was missing was freshness: an open target with no new events never
// re-entered any refresh path, so the board kept showing the discovery snapshot.
// These helpers make the change visible and keep what happened on record.

export interface PlanFacts {
  mintPriceWei: string;
  capPerWallet: number | null;
  feeRecipient: string | null;
}

export interface PriceHistoryEntry {
  at: string;
  priceWei: string;
  cap: number | null;
}

export interface FactsEntry {
  mintPriceWei: string | null;
  capPerWallet: number | null;
  feeRecipient: string | null;
  publicStart: number | null;
  endTime: number | null;
  factsAt: string | null;
  mintPriceChangedAt: string | null;
  priceHistory: PriceHistoryEntry[];
}

const HISTORY_LIMIT = 5;

// Records the freshly read plan on the entry: every field the refresh path can
// see, a timestamp for the whole set, and an explicit marker when the public
// price or the per-wallet cap moved.
export function applyPlanFacts(
  entry: FactsEntry,
  drop: { mintPrice: bigint; maxTotalMintableByWallet: number; startTime: number; endTime: number },
  feeRecipient: string | null,
  at: string
): { priceChanged: boolean } {
  const cap = drop.maxTotalMintableByWallet > 0 ? drop.maxTotalMintableByWallet : null;
  const previousPrice = entry.mintPriceWei;
  const previousCap = entry.capPerWallet;
  const priceChanged = previousPrice !== null && previousPrice !== drop.mintPrice.toString();
  const capChanged = previousCap !== null && previousCap !== cap;
  const changed = priceChanged || capChanged;

  entry.publicStart = drop.startTime;
  entry.endTime = drop.endTime;
  entry.mintPriceWei = drop.mintPrice.toString();
  entry.capPerWallet = cap;
  entry.feeRecipient = feeRecipient;
  entry.factsAt = at;

  if (changed) {
    entry.mintPriceChangedAt = at;
    const next: PriceHistoryEntry[] = [
      { at, priceWei: entry.mintPriceWei, cap },
      ...(entry.priceHistory ?? []).filter((point) => point.priceWei !== entry.mintPriceWei || point.cap !== cap),
    ];
    entry.priceHistory = next.slice(0, HISTORY_LIMIT);
  }
  return { priceChanged };
}

// A flip is the bait pattern: it became paid after having been free, or the
// price moved within an hour of the open (in either direction).
export function isPriceFlip(
  entry: FactsEntry,
  input: { nowMs: number; windowBeforeMs?: number; windowAfterMs?: number }
): boolean {
  const history = entry.priceHistory ?? [];
  const wasFree = history.some((point) => point.priceWei === "0");
  const isPaid = entry.mintPriceWei !== null && entry.mintPriceWei !== "0";
  if (wasFree && isPaid) return true;

  if (entry.mintPriceChangedAt === null || entry.publicStart === null) return false;
  const changedAtMs = Date.parse(entry.mintPriceChangedAt);
  if (!Number.isFinite(changedAtMs)) return false;
  const startMs = entry.publicStart * 1000;
  const before = input.windowBeforeMs ?? 3_600_000;
  const after = input.windowAfterMs ?? 3_600_000;
  return changedAtMs >= startMs - before && changedAtMs <= startMs + after;
}

// The board must prefer whichever source is fresher: a discovery snapshot can be
// hours older than a later audit, and taking the entry unconditionally is what
// kept the old price on screen.
export function freshest<T>(options: { value: T | null | undefined; at?: string | null }[]): T | null {
  let best: { value: T; atMs: number } | null = null;
  for (const option of options) {
    if (option.value === null || option.value === undefined) continue;
    const atMs = option.at ? Date.parse(option.at) : NaN;
    const score = Number.isFinite(atMs) ? atMs : 0;
    if (!best || score >= best.atMs) best = { value: option.value, atMs: score };
  }
  return best ? best.value : null;
}
