// Post-mint feedback: what did each minted NFT actually cost, and what is it
// worth at +24h / +72h?
//
// Two independent sources, recorded together:
//   - Seaport 1.6 OrderFulfilled logs give real trades on the chain, filtered by
//     the NFT's offer items. Payment may be native or an ERC-20 (Robinhood
//     collections price in USDG or WETH), so decimals are resolved on-chain and
//     never assumed to be 18.
//   - OpenSea collection stats give the listing floor when a key is configured.
//
// Cost comes from the mint transaction itself. Net value is only produced when
// both sides can be expressed in USD; comparing a USDG floor against an ETH cost
// would be meaningless.

import fs from "fs";
import path from "path";
import { formatEther, formatUnits, parseEther, parseUnits } from "ethers";
import { resolveChain } from "../chains";
import { resolveScanRpcs } from "../rpc-resolver";
import { Ledger, LedgerEntry } from "../batch-ledger";
import { SaleStats, scanSeaportSales } from "./seaport";

export const DEFAULT_BACKFILL_PATH = path.resolve(process.cwd(), ".backfill.jsonl");
export const DEFAULT_CHECKPOINTS_HOURS = [24, 72];
const NATIVE = "0x0000000000000000000000000000000000000000";

export interface BackfillRecord {
  at: string;
  chain: string;
  contract: string;
  slug: string | null;
  checkpointHours: number;
  mintAt: string;
  quantity: number;
  mintValueWei: string | null;
  gasCostWei: string | null;
  costWei: string | null;
  costUsd: number | null;
  floorSource: "seaport" | "opensea" | null;
  floorAtomic: string | null;
  floorDecimals: number | null;
  floorSymbol: string | null;
  floorUsd: number | null;
  lowAtomic: string | null;
  salesCount: number | null;
  uniqueBuyers: number | null;
  netUsd: number | null;
  txHash: string | null;
}

export interface CurrencyMeta {
  symbol: string | null;
  address: string;
  decimals: number;
  usdPrice: number | null;
  ethPrice: number | null;
}

export interface Pricing {
  listing: CurrencyMeta | null;
  offer: CurrencyMeta | null;
  ethUsd: number | null;
}

export function parsePricing(json: any): Pricing {
  const toCurrency = (raw: any): CurrencyMeta | null => {
    if (!raw) return null;
    const usd = Number(raw.usd_price);
    const eth = Number(raw.eth_price);
    return {
      symbol: typeof raw.symbol === "string" ? raw.symbol : null,
      address: String(raw.address ?? "").toLowerCase(),
      decimals: Number.isFinite(Number(raw.decimals)) ? Number(raw.decimals) : 18,
      usdPrice: Number.isFinite(usd) && usd > 0 ? usd : null,
      ethPrice: Number.isFinite(eth) && eth > 0 ? eth : null,
    };
  };

  const listing = toCurrency(json?.pricing_currencies?.listing_currency);
  const offer = toCurrency(json?.pricing_currencies?.offer_currency);

  let ethUsd: number | null = null;
  for (const currency of [listing, offer]) {
    if (!currency) continue;
    if (currency.address === NATIVE) {
      if (currency.usdPrice !== null) ethUsd = currency.usdPrice;
    } else if (currency.ethPrice !== null && currency.usdPrice !== null) {
      // e.g. USDG: 0.999874 USD / 0.000402757626169655 ETH -> ~2483 USD/ETH
      ethUsd = currency.usdPrice / currency.ethPrice;
    }
    if (ethUsd !== null) break;
  }
  return { listing, offer, ethUsd };
}

export function usdPriceFor(pricing: Pricing | null, token: string): number | null {
  if (!pricing) return null;
  if (token.toLowerCase() === NATIVE) return pricing.ethUsd;
  const wanted = token.toLowerCase();
  for (const currency of [pricing.listing, pricing.offer]) {
    if (currency && currency.address === wanted) return currency.usdPrice;
  }
  return null;
}

export function backfillKey(chain: string, contract: string, checkpointHours: number): string {
  return `${chain}|${contract.toLowerCase()}|${checkpointHours}`;
}

export function computeCost(mintValueWei: bigint, gasUsed: bigint, effectiveGasPrice: bigint): bigint {
  return mintValueWei + gasUsed * effectiveGasPrice;
}

export interface DueItem {
  chain: string;
  contract: string;
  slug: string | null;
  entry: LedgerEntry;
  checkpointHours: number;
  mintAtMs: number;
}

export function dueCheckpoints(
  ledger: Ledger,
  existing: BackfillRecord[],
  nowMs: number,
  horizonsHours: number[] = DEFAULT_CHECKPOINTS_HOURS
): DueItem[] {
  const done = new Set(existing.map((r) => backfillKey(r.chain, r.contract, r.checkpointHours)));
  const due: DueItem[] = [];
  for (const [chain, contracts] of Object.entries(ledger.entries)) {
    for (const [contract, entry] of Object.entries(contracts)) {
      if (entry.status !== "SUCCESS") continue;
      const mintAtMs = Date.parse(entry.at);
      if (!Number.isFinite(mintAtMs)) continue;
      for (const hours of horizonsHours) {
        if (nowMs < mintAtMs + hours * 3_600_000) continue;
        if (done.has(backfillKey(chain, contract, hours))) continue;
        due.push({ chain, contract, slug: entry.slug, entry, checkpointHours: hours, mintAtMs });
      }
    }
  }
  return due.sort((a, b) => a.mintAtMs - b.mintAtMs || a.checkpointHours - b.checkpointHours);
}

export function loadBackfill(file = DEFAULT_BACKFILL_PATH): BackfillRecord[] {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const parsed = JSON.parse(line);
          return parsed?.chain && parsed?.contract ? [parsed as BackfillRecord] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

export function appendBackfill(records: BackfillRecord[], file = DEFAULT_BACKFILL_PATH): void {
  if (records.length === 0) return;
  fs.appendFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

export interface StatsLike {
  floorAtomic: bigint | null;
  floorSymbol: string | null;
  volume24hAtomic: bigint | null;
  sales24h: number | null;
}

// OpenSea returns numbers in the collection's listing currency, whose decimals
// are NOT always 18 (USDG uses 6), so the caller passes them in.
export function parseStats(json: any, decimals = 18): StatsLike {
  const total = json?.total ?? json?.stats?.total ?? json ?? {};
  const days: any[] = Array.isArray(json?.intervals) ? json.intervals : [];
  const day = days.find((i) => i?.interval === "one_day") ?? {};

  const toAtomic = (value: unknown): bigint | null => {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return null;
    try {
      return parseUnits(String(n), decimals);
    } catch {
      return null;
    }
  };

  return {
    floorAtomic: toAtomic(total.floor_price),
    floorSymbol: typeof total.floor_price_symbol === "string" ? total.floor_price_symbol : null,
    volume24hAtomic: toAtomic(day.volume ?? total.one_day_volume),
    sales24h: Number.isFinite(Number(day.sales)) ? Number(day.sales) : null,
  };
}

export interface BackfillDeps {
  loadReceipt: (
    chain: string,
    txHash: string
  ) => Promise<{ valueWei: bigint; gasUsed: bigint; effectiveGasPrice: bigint } | null>;
  fetchStats: (chain: string, contract: string, slug: string | null) => Promise<StatsLike | null>;
  fetchPricing: (chain: string, contract: string, slug: string | null) => Promise<Pricing | null>;
  fetchSales: (chain: string, contract: string) => Promise<SaleStats | null>;
  erc20Meta: (chain: string, token: string) => Promise<{ decimals: number; symbol: string | null } | null>;
  now: () => number;
}

function apiKey(): string | null {
  const key = (process.env.OPENSEA_API_KEY || "").trim();
  return key.length > 0 ? key : null;
}

async function fetchJson(url: string, key: string | null, timeoutMs = 10_000): Promise<any | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json", ...(key ? { "x-api-key": key } : {}) },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function rpcCall(url: string, method: string, params: unknown[]): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
  });
  const json = (await res.json()) as { result?: any; error?: { message?: string } };
  if (json.error) throw new Error(json.error.message ?? "JSON-RPC error");
  return json.result;
}

const SELECTORS = {
  decimals: "0x313ce567",
  symbol: "0x95d89b41",
};

function decodeAbiString(hex: string): string | null {
  try {
    const body = hex.slice(2);
    if (body.length < 128) return null;
    const length = parseInt(body.slice(64, 128), 16);
    const data = body.slice(128, 128 + length * 2);
    return Buffer.from(data, "hex").toString("utf8").replace(/\0+$/, "");
  } catch {
    return null;
  }
}

async function resolveSlug(chain: string, contract: string, slug: string | null): Promise<string | null> {
  if (slug && !slug.startsWith("0x")) return slug;
  const key = apiKey();
  if (!key) return null;
  const reverse = await fetchJson(`https://api.opensea.io/api/v2/chain/${chain}/contract/${contract}`, key);
  return reverse?.collection ?? null;
}

const defaultDeps: BackfillDeps = {
  now: () => Date.now(),
  async loadReceipt(chain, txHash) {
    const url = resolveScanRpcs(chain).urls[0];
    if (!url) return null;
    try {
      const [tx, receipt] = await Promise.all([
        rpcCall(url, "eth_getTransactionByHash", [txHash]),
        rpcCall(url, "eth_getTransactionReceipt", [txHash]),
      ]);
      if (!receipt) return null;
      return {
        valueWei: BigInt(tx?.value ?? "0x0"),
        gasUsed: BigInt(receipt.gasUsed ?? "0x0"),
        effectiveGasPrice: BigInt(receipt.effectiveGasPrice ?? tx?.gasPrice ?? "0x0"),
      };
    } catch {
      return null;
    }
  },
  async erc20Meta(chain, token) {
    const url = resolveScanRpcs(chain).urls[0];
    if (!url) return null;
    try {
      const [decimalsRaw, symbolRaw] = await Promise.all([
        rpcCall(url, "eth_call", [{ to: token, data: SELECTORS.decimals }, "latest"]).catch(() => null),
        rpcCall(url, "eth_call", [{ to: token, data: SELECTORS.symbol }, "latest"]).catch(() => null),
      ]);
      if (!decimalsRaw) return null;
      return {
        decimals: Number(BigInt(decimalsRaw)),
        symbol: symbolRaw ? decodeAbiString(symbolRaw) : null,
      };
    } catch {
      return null;
    }
  },
  async fetchPricing(chain, contract, slug) {
    const resolved = await resolveSlug(chain, contract, slug);
    if (!resolved) return null;
    const collection = await fetchJson(`https://api.opensea.io/api/v2/collections/${resolved}`, apiKey());
    return collection ? parsePricing(collection) : null;
  },
  async fetchStats(chain, contract, slug) {
    const key = apiKey();
    if (!key) return null;
    const resolved = await resolveSlug(chain, contract, slug);
    if (!resolved) return null;
    const stats = await fetchJson(`https://api.opensea.io/api/v2/collections/${resolved}/stats`, key);
    return stats ? parseStats(stats) : null;
  },
  async fetchSales(chain, contract) {
    return scanSeaportSales(chain, contract, { lookbackHours: 24 });
  },
};

export interface BackfillOptions {
  ledgerPath: string;
  file?: string;
  horizonsHours?: number[];
  salesLookbackHours?: number;
  deps?: Partial<BackfillDeps>;
}

export interface BackfillSummary {
  due: number;
  written: number;
  withoutFloor: number;
  errors: string[];
}

export async function runBackfill(ledger: Ledger, opts: BackfillOptions): Promise<BackfillSummary> {
  const deps: BackfillDeps = { ...defaultDeps, ...opts.deps };
  const file = opts.file ?? DEFAULT_BACKFILL_PATH;
  const existing = loadBackfill(file);
  const due = dueCheckpoints(ledger, existing, deps.now(), opts.horizonsHours);

  const records: BackfillRecord[] = [];
  const errors: string[] = [];
  let withoutFloor = 0;

  for (const item of due) {
    const chainProfile = resolveChain(item.chain);
    if (!chainProfile) {
      errors.push(`${item.chain}/${item.contract}: unknown chain`);
      continue;
    }

    // A failed scan is reported, never treated as "no sales".
    let sales: SaleStats | null = null;
    try {
      sales = await deps.fetchSales(item.chain, item.contract);
    } catch (err) {
      errors.push(`${item.chain}/${item.contract}: seaport scan failed (${(err as Error).message})`);
    }

    const pricing = await deps.fetchPricing(item.chain, item.contract, item.slug).catch(() => null);
    const receipt = item.entry.txHash
      ? await deps.loadReceipt(item.chain, item.entry.txHash).catch(() => null)
      : null;

    const costWei = receipt ? computeCost(receipt.valueWei, receipt.gasUsed, receipt.effectiveGasPrice) : null;
    const costUsd = costWei !== null && pricing?.ethUsd != null ? Number(formatEther(costWei)) * pricing.ethUsd : null;

    let floorSource: BackfillRecord["floorSource"] = null;
    let floorAtomic: bigint | null = null;
    let floorDecimals: number | null = null;
    let floorSymbol: string | null = null;
    let floorUsd: number | null = null;
    let lowAtomic: bigint | null = null;
    let salesCount: number | null = null;
    let uniqueBuyers: number | null = null;

    if (sales) {
      const isNative = sales.payToken === NATIVE;
      const meta = isNative ? null : await deps.erc20Meta(item.chain, sales.payToken).catch(() => null);
      floorDecimals = isNative ? 18 : meta?.decimals ?? null;
      floorSymbol = isNative ? chainProfile.nativeSymbol : meta?.symbol ?? null;
      floorAtomic = sales.lowAtomic;
      lowAtomic = sales.lowAtomic;
      salesCount = sales.count;
      uniqueBuyers = sales.uniqueBuyers;
      floorSource = "seaport";
      const unitUsd = usdPriceFor(pricing, sales.payToken);
      if (unitUsd !== null && floorDecimals !== null) {
        floorUsd = Number(formatUnits(sales.lowAtomic, floorDecimals)) * unitUsd;
      }
    } else {
      const stats = await deps.fetchStats(item.chain, item.contract, item.slug).catch(() => null);
      if (stats) {
        floorSource = "opensea";
        floorDecimals = pricing?.listing?.decimals ?? 18;
        floorSymbol = stats.floorSymbol ?? pricing?.listing?.symbol ?? null;
        floorAtomic = stats.floorAtomic;
        salesCount = stats.sales24h;
        if (stats.floorAtomic !== null && pricing?.listing?.usdPrice != null) {
          floorUsd = Number(formatUnits(stats.floorAtomic, floorDecimals)) * pricing.listing.usdPrice;
        }
      }
    }

    if (!floorSource) withoutFloor++;

    if (costWei === null && floorAtomic === null) {
      errors.push(`${item.chain}/${item.contract}@${item.checkpointHours}h: no receipt and no floor — will retry`);
      continue;
    }

    const netUsd =
      floorUsd !== null && costUsd !== null ? floorUsd * item.entry.quantity - costUsd : null;

    records.push({
      at: new Date(deps.now()).toISOString(),
      chain: item.chain,
      contract: item.contract,
      slug: item.slug,
      checkpointHours: item.checkpointHours,
      mintAt: item.entry.at,
      quantity: item.entry.quantity,
      mintValueWei: receipt ? receipt.valueWei.toString() : null,
      gasCostWei: receipt ? (receipt.gasUsed * receipt.effectiveGasPrice).toString() : null,
      costWei: costWei === null ? null : costWei.toString(),
      costUsd,
      floorSource,
      floorAtomic: floorAtomic === null ? null : floorAtomic.toString(),
      floorDecimals,
      floorSymbol,
      floorUsd,
      lowAtomic: lowAtomic === null ? null : lowAtomic.toString(),
      salesCount,
      uniqueBuyers,
      netUsd,
      txHash: item.entry.txHash,
    });
  }

  appendBackfill(records, file);
  return { due: due.length, written: records.length, withoutFloor, errors };
}

export function formatNetUsd(record: BackfillRecord): string | null {
  return record.netUsd === null ? null : `$${record.netUsd.toFixed(4)}`;
}
