// Valuation guardrails, borrowed from mint-desk's approach: a floor price is a
// seller's ask, not a fill. Only when there are several independent sales by
// several different buyers, recent enough to matter, do we allow a reference
// price — and even then each buyer contributes a single median so one bulk
// buyer cannot define the market.
//
// Nothing here promises a fill. The dashboard shows the difference between
// "traded" and "listed", never a profit number for an unopened drop.

export interface SaleSample {
  value: number; // native token units
  buyer: string;
  txHash: string;
  atMs: number;
}

export interface ValuationInput {
  sales: SaleSample[];
  floor: number | null;
  topOffer: number | null;
  nowMs: number;
}

export interface ValuationResult {
  supported: boolean;
  reference: number | null;
  lowerQuartile: number | null;
  independentTransactions: number;
  pricedBuyers: number;
  floorDivergence: boolean;
  reason: string | null;
}

const DAY_MS = 86_400_000;
const FRESH_MS = 6 * 3_600_000;
const MIN_TXS = 3;
const MIN_BUYERS = 2;
const LOWER_QUARTILE_DISCOUNT = 0.8;
const DIVERGENCE_FACTOR = 3;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
}

export function conservativeValuation(input: ValuationInput): ValuationResult {
  const { nowMs } = input;
  const seen = new Set<string>();
  const samples = input.sales.filter((sale) => {
    if (!Number.isFinite(sale.value) || sale.value <= 0) return false;
    if (!Number.isFinite(sale.atMs) || sale.atMs > nowMs || sale.atMs < nowMs - DAY_MS) return false;
    if (!/^0x[0-9a-f]{64}$/i.test(sale.txHash ?? "")) return false;
    if (!sale.buyer || /^0x0+$/i.test(sale.buyer)) return false;
    const key = sale.txHash.toLowerCase();
    if (seen.has(key)) return false; // one row per transaction
    seen.add(key);
    return true;
  });

  const buyers = new Map<string, number[]>();
  for (const sale of samples) {
    const key = sale.buyer.toLowerCase();
    (buyers.get(key) ?? buyers.set(key, []).get(key)!).push(sale.value);
  }

  const buyerMedians = [...buyers.values()].map(median).sort((a, b) => a - b);
  const lowerQuartile = buyerMedians.length > 0 ? buyerMedians[Math.floor((buyerMedians.length - 1) * 0.25)] : null;
  const fresh = samples.some((sale) => sale.atMs >= nowMs - FRESH_MS);
  const supported = seen.size >= MIN_TXS && buyers.size >= MIN_BUYERS && fresh;

  let reference: number | null = null;
  if (supported && input.floor !== null && input.floor > 0 && lowerQuartile !== null && lowerQuartile > 0) {
    const candidates = [input.floor, lowerQuartile * LOWER_QUARTILE_DISCOUNT];
    if (input.topOffer !== null && input.topOffer > 0) candidates.push(input.topOffer);
    reference = Math.min(...candidates);
  }

  return {
    supported,
    reference,
    lowerQuartile,
    independentTransactions: seen.size,
    pricedBuyers: buyers.size,
    floorDivergence:
      input.floor !== null && lowerQuartile !== null && lowerQuartile > 0 && input.floor > lowerQuartile * DIVERGENCE_FACTOR,
    reason: supported ? null : "成交依据不足：需 24h 内至少 3 笔不同交易、2 个不同买家，且近 6h 有成交",
  };
}

export type LiquidityLevel = "traded" | "thin" | "stale-evidence" | "unknown";

export interface BackfillEvidence {
  salesCount: number | null;
  uniqueBuyers: number | null;
  checkedAtMs: number;
}

// Our own cheaper evidence: the latest backfill checkpoint for the target. It is
// a summary, not per-sale samples, so it can label liquidity but never produce
// a reference price on its own.
export function liquidityVerdict(
  evidence: BackfillEvidence | null,
  nowMs: number
): { level: LiquidityLevel; label: string } {
  if (!evidence || evidence.salesCount === null) return { level: "unknown", label: "无成交数据" };
  if (Number.isFinite(evidence.checkedAtMs) && nowMs - evidence.checkedAtMs > FRESH_MS) {
    return { level: "stale-evidence", label: "成交数据过旧" };
  }
  if (evidence.salesCount >= 3 && (evidence.uniqueBuyers ?? 0) >= 2) return { level: "traded", label: "有成交" };
  return { level: "thin", label: "成交样本不足" };
}
