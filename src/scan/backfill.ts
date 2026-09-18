// Post-mint feedback: what did each minted NFT actually cost, and what is it
// worth at +24h / +72h?
//
// The cost comes from the chain (the tx's own value plus the receipt's gas),
// which needs no key. The floor price comes from OpenSea stats when a key is
// configured; on Robinhood and Arc there is no secondary market to read instead
// (seven days of Seaport OrderFulfilled logs contained zero sales), so the
// stats path is the only source and its absence degrades the record rather than
// failing the run.
//
// Idempotent per (chain, contract, checkpoint): re-running never duplicates.

import fs from "fs";
import path from "path";
import { formatEther, parseEther } from "ethers";
import { resolveChain } from "../chains";
import { resolveScanRpcs } from "../rpc-resolver";
import { Ledger, LedgerEntry } from "../batch-ledger";

export const DEFAULT_BACKFILL_PATH = path.resolve(process.cwd(), ".backfill.jsonl");
export const DEFAULT_CHECKPOINTS_HOURS = [24, 72];

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
  floorPriceWei: string | null;
  floorSymbol: string | null;
  volume24hWei: string | null;
  sales24h: number | null;
  netWei: string | null;
  txHash: string | null;
}

export interface DueItem {
  chain: string;
  contract: string;
  slug: string | null;
  entry: LedgerEntry;
  checkpointHours: number;
  mintAtMs: number;
}

export function backfillKey(chain: string, contract: string, checkpointHours: number): string {
  return `${chain}|${contract.toLowerCase()}|${checkpointHours}`;
}

export function computeCost(mintValueWei: bigint, gasUsed: bigint, effectiveGasPrice: bigint): bigint {
  return mintValueWei + gasUsed * effectiveGasPrice;
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

// OpenSea returns numbers in native units (e.g. 0.05), so they are converted to
// wei for a consistent record. Both the v2 `total` block and an `intervals`
// entry may carry the numbers.
export interface StatsLike {
  floorPriceWei: bigint | null;
  floorSymbol: string | null;
  volume24hWei: bigint | null;
  sales24h: number | null;
}

export function parseStats(json: any): StatsLike {
  const total = json?.total ?? json?.stats?.total ?? json ?? {};
  const days: any[] = Array.isArray(json?.intervals) ? json.intervals : [];
  const day = days.find((i) => i?.interval === "one_day") ?? {};

  const toWei = (value: unknown): bigint | null => {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return null;
    // String(0.05) round-trips exactly; toFixed(18) would carry a float error.
    try {
      return parseEther(String(n));
    } catch {
      return parseEther(n.toFixed(18));
    }
  };

  return {
    floorPriceWei: toWei(total.floor_price),
    floorSymbol: typeof total.floor_price_symbol === "string" ? total.floor_price_symbol : null,
    volume24hWei: toWei(day.volume ?? total.one_day_volume),
    sales24h: Number.isFinite(Number(day.sales)) ? Number(day.sales) : null,
  };
}

export interface BackfillDeps {
  loadReceipt: (
    chain: string,
    txHash: string
  ) => Promise<{ valueWei: bigint; gasUsed: bigint; effectiveGasPrice: bigint } | null>;
  fetchStats: (chain: string, contract: string, slug: string | null) => Promise<StatsLike | null>;
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

const defaultDeps: BackfillDeps = {
  now: () => Date.now(),
  async loadReceipt(chain, txHash) {
    const url = resolveScanRpcs(chain).urls[0];
    if (!url) return null;
    const call = async (method: string, params: unknown[]) => {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
      });
      const json = (await res.json()) as { result?: any; error?: { message?: string } };
      if (json.error) throw new Error(json.error.message ?? "JSON-RPC error");
      return json.result;
    };
    try {
      const [tx, receipt] = await Promise.all([
        call("eth_getTransactionByHash", [txHash]),
        call("eth_getTransactionReceipt", [txHash]),
      ]);
      if (!receipt) return null;
      const gasUsed = BigInt(receipt.gasUsed ?? "0x0");
      const gasPrice = receipt.effectiveGasPrice ?? tx?.gasPrice ?? "0x0";
      return {
        valueWei: BigInt(tx?.value ?? "0x0"),
        gasUsed,
        effectiveGasPrice: BigInt(gasPrice),
      };
    } catch {
      return null;
    }
  },
  async fetchStats(chain, contract, slug) {
    const key = apiKey();
    if (!key) return null;
    let resolved = slug && !slug.startsWith("0x") ? slug : null;
    if (!resolved) {
      const reverse = await fetchJson(`https://api.opensea.io/api/v2/chain/${chain}/contract/${contract}`, key);
      resolved = reverse?.collection ?? null;
    }
    if (!resolved) return null;
    const stats = await fetchJson(`https://api.opensea.io/api/v2/collections/${resolved}/stats`, key);
    return stats ? parseStats(stats) : null;
  },
};

export interface BackfillOptions {
  ledgerPath: string;
  file?: string;
  horizonsHours?: number[];
  deps?: Partial<BackfillDeps>;
}

export interface BackfillSummary {
  due: number;
  written: number;
  withoutStats: number;
  errors: string[];
}

export async function runBackfill(ledger: Ledger, opts: BackfillOptions): Promise<BackfillSummary> {
  const deps: BackfillDeps = { ...defaultDeps, ...opts.deps };
  const file = opts.file ?? DEFAULT_BACKFILL_PATH;
  const existing = loadBackfill(file);
  const due = dueCheckpoints(ledger, existing, deps.now(), opts.horizonsHours);

  const records: BackfillRecord[] = [];
  const errors: string[] = [];
  let withoutStats = 0;

  for (const item of due) {
    const chainProfile = resolveChain(item.chain);
    if (!chainProfile) {
      errors.push(`${item.chain}/${item.contract}: unknown chain`);
      continue;
    }
    const txHash = item.entry.txHash;
    const receipt = txHash ? await deps.loadReceipt(item.chain, txHash).catch(() => null) : null;
    const stats = await deps.fetchStats(item.chain, item.contract, item.slug).catch(() => null);
    if (!stats) withoutStats++;

    const costWei = receipt ? computeCost(receipt.valueWei, receipt.gasUsed, receipt.effectiveGasPrice) : null;
    const floorPriceWei = stats?.floorPriceWei ?? null;
    const netWei =
      floorPriceWei !== null && costWei !== null
        ? floorPriceWei * BigInt(item.entry.quantity) - costWei
        : null;

    if (costWei === null && floorPriceWei === null) {
      errors.push(`${item.chain}/${item.contract}@${item.checkpointHours}h: no receipt and no stats — will retry`);
      continue;
    }

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
      floorPriceWei: floorPriceWei === null ? null : floorPriceWei.toString(),
      floorSymbol: stats?.floorSymbol ?? chainProfile.nativeSymbol,
      volume24hWei: stats?.volume24hWei?.toString() ?? null,
      sales24h: stats?.sales24h ?? null,
      netWei: netWei === null ? null : netWei.toString(),
      txHash,
    });
  }

  appendBackfill(records, file);
  return { due: due.length, written: records.length, withoutStats, errors };
}

export function formatNet(record: BackfillRecord): string | null {
  return record.netWei === null ? null : formatEther(BigInt(record.netWei));
}
