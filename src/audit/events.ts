// SeaDrop event scanning.
//
// The SeaDrop singleton emits everything an audit needs from one address:
// config changes (PublicDropUpdated) and every mint across every drop
// (SeaDropMint), with the stage index attached. Reading the singleton once is
// cheaper and more complete than walking token contracts.
//
// Public RPCs cap eth_getLogs ranges — Arc rejects anything above 5,000 blocks,
// Robinhood takes 100,000 — so ranges are split per chain, run with a small
// concurrency, and retried with backoff (a parallel scan of the full range sees
// roughly one in six windows fail transiently).

import { Interface, id } from "ethers";

export const SEADROP_MINT_TOPIC = id(
  "SeaDropMint(address,address,address,address,uint256,uint256,uint256,uint256)"
);
export const PUBLIC_DROP_UPDATED_TOPIC = id(
  "PublicDropUpdated(address,(uint80,uint48,uint48,uint16,uint16,bool))"
);

// indexed: nftContract, minter, feeRecipient | data: payer, quantity, mintPrice, feeBps, dropStageIndex
const MINT_IFACE = new Interface([
  "event SeaDropMint(address indexed nftContract, address indexed minter, address indexed feeRecipient, address payer, uint256 quantity, uint256 mintPrice, uint256 feeBps, uint256 dropStageIndex)",
]);
const DROP_IFACE = new Interface([
  "event PublicDropUpdated(address indexed nftContract, tuple(uint80 mintPrice, uint48 startTime, uint48 endTime, uint16 maxTotalMintableByWallet, uint16 feeBps, bool restrictFeeRecipients) newPublicDrop)",
]);

const WINDOWS: Record<string, number> = { robinhood: 100_000, arc: 5_000 };
const DEFAULT_WINDOW = 10_000;

// Public RPCs throttle hard even at low parallelism; run scans serially. Private
// endpoints (RPC_URL_<CHAIN>) are what make this fast, not concurrency.
const SCAN_CONCURRENCY: Record<string, number> = { arc: 1, robinhood: 1 };
const DEFAULT_CONCURRENCY = 2;

export function windowBlocks(chainKey: string): number {
  return WINDOWS[chainKey] ?? DEFAULT_WINDOW;
}

export function scanConcurrency(chainKey: string): number {
  return SCAN_CONCURRENCY[chainKey] ?? DEFAULT_CONCURRENCY;
}

// Discovery queries the singleton without a contract filter, so a window that is
// comfortable for one contract can return tens of thousands of logs. Keep those
// windows small; the adaptive split below covers anything still too dense.
export function discoveryWindowBlocks(chainKey: string): number {
  return Math.min(windowBlocks(chainKey), 10_000);
}

// Providers word the "too many results" rejection differently.
export function isDenseLogError(message: string): boolean {
  return /exceeds limit|too many results|more than \d+ results|response size|query returned more|limit of 10000/i.test(
    message
  );
}

export function splitWindows(fromBlock: number, toBlock: number, window: number): { from: number; to: number }[] {
  const windows: { from: number; to: number }[] = [];
  for (let from = fromBlock; from <= toBlock; from += window) {
    windows.push({ from, to: Math.min(from + window - 1, toBlock) });
  }
  return windows;
}

export interface RawLog {
  topics: string[];
  data: string;
  blockNumber: string;
}

export interface ScanDeps {
  rpcUrl: string;
  concurrency?: number;
  maxRetries?: number;
  timeoutMs?: number;
  window?: number; // override the per-chain window (discovery uses a smaller one)
  minWindow?: number; // bisection floor, default 64 blocks
  onProgress?: (message: string) => void;
}

const hex = (n: number | bigint): string => "0x" + n.toString(16);

export async function rpcCall<T>(url: string, method: string, params: unknown[], timeoutMs = 15_000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
      signal: controller.signal,
    });
    const json = (await res.json()) as { result?: T; error?: { message?: string } };
    if (json.error) throw new Error(json.error.message ?? "JSON-RPC error");
    return json.result as T;
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function withRetry<T>(fn: () => Promise<T>, deps: ScanDeps, label: string): Promise<T> {
  const maxRetries = deps.maxRetries ?? 4;
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === maxRetries) break;
      deps.onProgress?.(`${label}: ${(err as Error).message} — retry ${attempt + 1}/${maxRetries}`);
      // Rate-limited public RPCs need patience more than speed, so those errors
      // back off much further; jitter keeps parallel workers out of lockstep.
      const limited = /rate limit|too many requests|429/i.test((err as Error).message);
      const backoff = Math.min(limited ? 15_000 : 8_000, (limited ? 500 : 250) * 2 ** attempt);
      await sleep(backoff / 2 + Math.random() * (backoff / 2));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function scanLogs(
  chainKey: string,
  address: string,
  topics: unknown[],
  fromBlock: number,
  toBlock: number,
  deps: ScanDeps
): Promise<RawLog[]> {
  const windowSize = deps.window ?? windowBlocks(chainKey);
  const windows = splitWindows(fromBlock, toBlock, windowSize);
  const results: RawLog[][] = new Array(windows.length).fill([]);
  const reportEvery = Math.max(1, Math.floor(windows.length / 4));
  const minWindow = deps.minWindow ?? 64;
  let cursor = 0;

  // A window answered with "too many results" is halved and retried; the floor
  // keeps a pathological range from recursing forever.
  const fetchWindow = async (w: { from: number; to: number }, label: string): Promise<RawLog[]> => {
    try {
      return await withRetry(
        () => rpcCall<RawLog[]>(deps.rpcUrl, "eth_getLogs", [{ address, topics, fromBlock: hex(w.from), toBlock: hex(w.to) }], deps.timeoutMs),
        deps,
        label
      );
    } catch (err) {
      const message = (err as Error).message;
      if (!isDenseLogError(message) || w.to - w.from < minWindow) throw err;
      const mid = Math.floor((w.from + w.to) / 2);
      deps.onProgress?.(`window ${w.from}..${w.to} too dense — splitting`);
      return [
        ...(await fetchWindow({ from: w.from, to: mid }, label)),
        ...(await fetchWindow({ from: mid + 1, to: w.to }, label)),
      ];
    }
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= windows.length) return;
      results[index] = await fetchWindow(windows[index], `logs ${index + 1}/${windows.length}`);
      const done = index + 1;
      if (done % reportEvery === 0 || done === windows.length) {
        deps.onProgress?.(`scanned ${done}/${windows.length} windows`);
      }
    }
  };

  const workers = Math.max(1, Math.min(deps.concurrency ?? scanConcurrency(chainKey), windows.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return results.flat();
}

export interface StageMint {
  stage: number;
  txs: number;
  tokens: bigint;
  uniqueMinters: number;
  topMinterTokens: bigint;
  firstBlock: number;
  lastBlock: number;
  price: bigint;
}

export interface MintScan {
  stages: StageMint[];
  totalTxs: number;
  totalTokens: bigint;
  uniqueMinters: number;
  topMinterShare: number; // 0..1
  firstBlock: number | null;
  lastBlock: number | null;
  recentTokens: bigint; // tokens minted in blocks >= recentFromBlock
}

export interface DecodedMint {
  nftContract: string;
  minter: string;
  feeRecipient: string;
  payer: string;
  quantity: bigint;
  mintPrice: bigint;
  feeBps: number;
  stage: number;
  block: number;
}

export function decodeMintLog(log: RawLog): DecodedMint | null {
  try {
    const parsed = MINT_IFACE.parseLog({ topics: [...log.topics], data: log.data });
    if (!parsed) return null;
    return {
      nftContract: String(parsed.args.nftContract),
      minter: String(parsed.args.minter),
      feeRecipient: String(parsed.args.feeRecipient),
      payer: String(parsed.args.payer),
      quantity: BigInt(parsed.args.quantity),
      mintPrice: BigInt(parsed.args.mintPrice),
      feeBps: Number(parsed.args.feeBps),
      stage: Number(parsed.args.dropStageIndex),
      block: Number(BigInt(log.blockNumber)),
    };
  } catch {
    return null;
  }
}

export function aggregateMints(logs: RawLog[], recentFromBlock: number): MintScan {
  const stages = new Map<number, StageMint>();
  const stageMinters = new Map<number, Map<string, bigint>>();
  const globalMinters = new Map<string, bigint>();
  let totalTxs = 0;
  let totalTokens = 0n;
  let recentTokens = 0n;
  let firstBlock: number | null = null;
  let lastBlock: number | null = null;

  for (const log of logs) {
    const mint = decodeMintLog(log);
    if (!mint) continue;

    totalTxs++;
    totalTokens += mint.quantity;
    if (mint.block >= recentFromBlock) recentTokens += mint.quantity;
    firstBlock = firstBlock === null ? mint.block : Math.min(firstBlock, mint.block);
    lastBlock = lastBlock === null ? mint.block : Math.max(lastBlock, mint.block);

    const entry = stages.get(mint.stage) ?? {
      stage: mint.stage,
      txs: 0,
      tokens: 0n,
      uniqueMinters: 0,
      topMinterTokens: 0n,
      firstBlock: mint.block,
      lastBlock: mint.block,
      price: mint.mintPrice,
    };
    entry.txs++;
    entry.tokens += mint.quantity;
    entry.lastBlock = mint.block;
    entry.price = mint.mintPrice;
    stages.set(mint.stage, entry);

    const perStage = stageMinters.get(mint.stage) ?? new Map<string, bigint>();
    perStage.set(mint.minter, (perStage.get(mint.minter) ?? 0n) + mint.quantity);
    stageMinters.set(mint.stage, perStage);

    globalMinters.set(mint.minter, (globalMinters.get(mint.minter) ?? 0n) + mint.quantity);
  }

  for (const [stage, minterMap] of stageMinters) {
    const entry = stages.get(stage)!;
    entry.uniqueMinters = minterMap.size;
    entry.topMinterTokens = [...minterMap.values()].reduce((max, v) => (v > max ? v : max), 0n);
  }

  const topTokens = [...globalMinters.values()].reduce((max, v) => (v > max ? v : max), 0n);
  return {
    stages: [...stages.values()].sort((a, b) => a.stage - b.stage),
    totalTxs,
    totalTokens,
    uniqueMinters: globalMinters.size,
    topMinterShare: totalTokens > 0n ? Number((topTokens * 10_000n) / totalTokens) / 10_000 : 0,
    firstBlock,
    lastBlock,
    recentTokens,
  };
}

export interface DropUpdate {
  block: number;
  price: bigint;
  startTime: number;
  endTime: number;
  cap: number;
}

export function decodeDropUpdates(logs: RawLog[]): DropUpdate[] {
  const updates: DropUpdate[] = [];
  for (const log of logs) {
    try {
      const parsed = DROP_IFACE.parseLog({ topics: [...log.topics], data: log.data });
      if (!parsed) continue;
      const d = parsed.args.newPublicDrop;
      updates.push({
        block: Number(BigInt(log.blockNumber)),
        price: BigInt(d.mintPrice),
        startTime: Number(d.startTime),
        endTime: Number(d.endTime),
        cap: Number(d.maxTotalMintableByWallet),
      });
    } catch {
      // skip malformed
    }
  }
  return updates.sort((a, b) => a.block - b.block);
}

export interface ChangeSummary {
  priceChanges: number;
  startChanges: number;
  capChanges: number;
  lastPriceChangeAtBlock: number | null;
  lastStartChangeAtBlock: number | null;
  firstStartTime: number | null;
  finalStartTime: number | null;
}

export function summarizeChanges(updates: DropUpdate[]): ChangeSummary {
  const summary: ChangeSummary = {
    priceChanges: 0,
    startChanges: 0,
    capChanges: 0,
    lastPriceChangeAtBlock: null,
    lastStartChangeAtBlock: null,
    firstStartTime: updates[0]?.startTime ?? null,
    finalStartTime: updates[updates.length - 1]?.startTime ?? null,
  };
  for (let i = 1; i < updates.length; i++) {
    const prev = updates[i - 1];
    const next = updates[i];
    if (next.price !== prev.price) {
      summary.priceChanges++;
      summary.lastPriceChangeAtBlock = next.block;
    }
    if (next.startTime !== prev.startTime) {
      summary.startChanges++;
      summary.lastStartChangeAtBlock = next.block;
    }
    if (next.cap !== prev.cap) summary.capChanges++;
  }
  return summary;
}

export async function latestBlockNumber(rpcUrl: string, deps?: Partial<ScanDeps>): Promise<number> {
  const raw = await withRetry(() => rpcCall<string>(rpcUrl, "eth_blockNumber", [], deps?.timeoutMs), { rpcUrl, ...deps }, "blockNumber");
  return Number(BigInt(raw));
}

export async function estimateBlockTime(
  rpcUrl: string,
  sampleBlocks = 20_000
): Promise<{ latestBlock: number; secondsPerBlock: number; latestTimestamp: number }> {
  const latestBlock = await latestBlockNumber(rpcUrl);
  const [latest, older] = await Promise.all([
    rpcCall<{ timestamp: string }>(rpcUrl, "eth_getBlockByNumber", [hex(latestBlock), false]),
    rpcCall<{ timestamp: string }>(rpcUrl, "eth_getBlockByNumber", [hex(Math.max(1, latestBlock - sampleBlocks)), false]),
  ]);
  const seconds = Number(BigInt(latest.timestamp)) - Number(BigInt(older.timestamp));
  const blocks = latestBlock - Math.max(1, latestBlock - sampleBlocks);
  return {
    latestBlock,
    secondsPerBlock: blocks > 0 && seconds > 0 ? seconds / blocks : 1,
    latestTimestamp: Number(BigInt(latest.timestamp)),
  };
}

export async function fetchBlockTimestamps(rpcUrl: string, blocks: number[]): Promise<Map<number, number>> {
  const unique = [...new Set(blocks)];
  const out = new Map<number, number>();
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= unique.length) return;
      const block = unique[index];
      try {
        const header = await rpcCall<{ timestamp: string }>(rpcUrl, "eth_getBlockByNumber", [hex(block), false]);
        out.set(block, Number(BigInt(header.timestamp)));
      } catch {
        // timestamp missing only softens a risk flag; never fail the audit over it
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, unique.length) }, worker));
  return out;
}
