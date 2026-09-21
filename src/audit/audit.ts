// Target audit: pull everything public about a drop, then grade it.
//
// The two questions that decide whether a public mint is worth queueing — is
// there any supply left, and did the creator change terms late — are answered
// from chain data alone. OpenSea is enrichment: a missing key or a rate limit
// never changes the grade.

import { Contract, JsonRpcProvider, getAddress } from "ethers";
import { resolveChain } from "../chains";
import { planRpcs, resolveScanRpcs } from "../rpc-resolver";
import { parseNftLink } from "../nft-link";
import { resolveSlug } from "../slug-resolver";
import { buildLocalMintPlan, fetchMintStats, PublicDrop, SEADROP_ADDRESS } from "../seadrop-public";
import { smartOverlap } from "../scan/smart-minters";
import { codeHashOf } from "../gates";
import {
  ChangeSummary,
  DropUpdate,
  MintScan,
  PUBLIC_DROP_UPDATED_TOPIC,
  SEADROP_MINT_TOPIC,
  aggregateMints,
  decodeDropUpdates,
  estimateBlockTime,
  fetchBlockTimestamps,
  scanLogs,
  summarizeChanges,
} from "./events";
import { GradeResult, gradeTarget, isRateConfident } from "./score";
import { DEFAULT_CACHE_DIR, isFresh, readCache, writeCache } from "./cache";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const RECENT_WINDOW_MINUTES = 15;
const DEFAULT_LOOKBACK_DAYS = 7;
const CACHE_TTL_MS = 5 * 60_000;

export interface AuditInput {
  chainKey: string;
  target: string; // OpenSea link, slug, or contract address
}

export interface AuditOptions {
  wallets?: string[];
  // Auto-derived winners from previous sold-out drops (see scan/smart-minters).
  smartSet?: Set<string>;
  requestedQuantity?: number;
  lookbackDays?: number;
  maxRetries?: number; // per-window retries while scanning events
  cacheDir?: string;
  cacheTtlMs?: number;
  onProgress?: (message: string) => void;
}

export interface ApiStage {
  label: string;
  stageType: string;
  price: string;
  startTime: string;
  endTime: string;
  maxPerWallet: number | null;
  allowlistCount: number | null;
}

export interface Social {
  twitter: string | null; // handle, not a URL
  discord: string | null; // invite URL
  website: string | null; // project URL
  imageUrl: string | null;
  createdDate: string | null;
  safelist: string | null;
}

export interface AuditResult {
  chainKey: string;
  chainName: string;
  contract: string;
  slug: string | null;
  name: string | null;
  owner: string | null;
  applicable: boolean;
  notApplicableReason?: string;
  publicDrop: PublicDrop | null;
  feeRecipient: string | null;
  signerCount: number;
  allowedFeeRecipientCount: number;
  maxSupply: bigint | null;
  totalMinted: bigint;
  walletMints: { address: string; minted: bigint }[];
  mintScan: MintScan;
  recentWindowMinutes: number;
  sampleMinutes: number;
  scanCoverage: number; // observed mints / total minted (1 when nothing minted)
  updates: (DropUpdate & { at: number | null })[];
  changes: ChangeSummary;
  apiStages: ApiStage[] | null;
  social: Social | null;
  smartMinters: number;
  codeHash: string | null; // bytecode hash at audit time (B2 gate 1)
  grade: GradeResult;
  errors: string[];
}

const EMPTY_SCAN: MintScan = {
  stages: [],
  totalTxs: 0,
  totalTokens: 0n,
  uniqueMinters: 0,
  topMinterShare: 0,
  firstBlock: null,
  lastBlock: null,
  recentTokens: 0n,
  recentByWindow: {},
  maxTxTokens: 0n,
  payerDiffers: 0,
  topMinters: [],
};

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

function csv(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// The cache is JSON, so the bigint fields have to be carried as strings.
interface CachedPayload { mintScan: unknown; updates: unknown[] }

function serializeScan(scan: MintScan): unknown {
  return {
    ...scan,
    totalTokens: scan.totalTokens.toString(),
    recentTokens: scan.recentTokens.toString(),
    recentByWindow: Object.fromEntries(Object.entries(scan.recentByWindow ?? {}).map(([label, value]) => [label, value.toString()])),
    maxTxTokens: scan.maxTxTokens.toString(),
    topMinters: scan.topMinters.map((m) => ({ address: m.address, tokens: m.tokens.toString() })),
    stages: scan.stages.map((s) => ({
      ...s,
      tokens: s.tokens.toString(),
      topMinterTokens: s.topMinterTokens.toString(),
      price: s.price.toString(),
    })),
  };
}

function deserializeScan(raw: any): MintScan {
  return {
    ...raw,
    totalTokens: BigInt(raw.totalTokens ?? 0),
    recentTokens: BigInt(raw.recentTokens ?? 0),
    recentByWindow: Object.fromEntries(
      Object.entries(raw.recentByWindow ?? {}).map(([label, value]) => [label, BigInt(String(value))])
    ),
    maxTxTokens: BigInt(raw.maxTxTokens ?? 0),
    payerDiffers: Number(raw.payerDiffers ?? 0),
    topMinters: ((raw.topMinters ?? []) as any[]).map((m) => ({ address: String(m.address), tokens: BigInt(m.tokens ?? 0) })),
    stages: (raw.stages ?? []).map((s: any) => ({
      ...s,
      tokens: BigInt(s.tokens ?? 0),
      topMinterTokens: BigInt(s.topMinterTokens ?? 0),
      price: BigInt(s.price ?? 0),
    })),
  };
}

function serializeUpdates(updates: (DropUpdate & { at: number | null })[]): unknown[] {
  return updates.map((u) => ({ ...u, price: u.price.toString() }));
}

function deserializeUpdates(raw: any[]): (DropUpdate & { at: number | null })[] {
  return (raw ?? []).map((u) => ({ ...u, price: BigInt(u.price ?? 0) }));
}

export interface CachedScan {
  mintScan: MintScan;
  updates: (DropUpdate & { at: number | null })[];
  scannedAt: number;
}


// Offline reader for the dashboard: no network, null when nothing is cached.
export function readCachedScan(
  chainKey: string,
  contract: string,
  cacheDir = DEFAULT_CACHE_DIR
): CachedScan | null {
  const cached = readCache<{ mintScan: unknown; updates: unknown[] }>(chainKey, contract, cacheDir);
  if (!cached) return null;
  try {
    return {
      mintScan: deserializeScan(cached.data.mintScan),
      updates: deserializeUpdates(cached.data.updates),
      scannedAt: cached.scannedAt,
    };
  } catch {
    return null;
  }
}

export async function auditTarget(input: AuditInput, opts: AuditOptions = {}): Promise<AuditResult> {
  const chain = resolveChain(input.chainKey);
  if (!chain) throw new Error(`Unsupported chain "${input.chainKey}"`);
  const progress = opts.onProgress ?? (() => {});
  const errors: string[] = [];

  // ── target → contract ────────────────────────────────────────────────
  const link = parseNftLink(input.target);
  let contract: string;
  let slug: string | null = link.kind === "slug" ? link.value : null;
  let name: string | null = null;

  if (link.kind === "address") {
    contract = link.value;
  } else {
    const info = await resolveSlug(link.value, apiKey() ?? undefined, chain.key);
    contract = info.contractAddress;
    name = info.name || null;
    const on = info.chain ? resolveChain(info.chain) : undefined;
    if (on && on.key !== chain.key) {
      throw new Error(`"${input.target}" resolves on ${on.name}, not ${chain.name}.`);
    }
  }

  // ── RPC ──────────────────────────────────────────────────────────────
  // Log scans use the scan-role endpoints: a sending-optimised private RPC can
  // cap eth_getLogs ranges far below what a scan needs.
  const { urls } = resolveScanRpcs(chain.key);
  const rpcPlan = await planRpcs(urls, chain.chainId);
  if (!rpcPlan.verified || rpcPlan.urls.length === 0) {
    throw new Error(`No RPC endpoint confirmed chain ID ${chain.chainId} (${chain.name}).`);
  }
  const rpcUrl = rpcPlan.urls[0];

  // ── chain reads ──────────────────────────────────────────────────────
  const requestedQuantity = Math.max(1, Math.floor(opts.requestedQuantity ?? 1));
  const plan = await buildLocalMintPlan(rpcUrl, contract, requestedQuantity);
  const statsZero = await fetchMintStats(rpcUrl, contract, ZERO_ADDRESS);
  const walletMints = await Promise.all(
    (opts.wallets ?? []).map(async (address) => ({
      address,
      minted: (await fetchMintStats(rpcUrl, contract, address))?.mintedByWallet ?? 0n,
    }))
  );

  const provider = new JsonRpcProvider(rpcUrl);
  // Pin the bytecode now: an execution must refuse to sign if it changed.
  const codeHash = codeHashOf(await provider.getCode(contract).catch(() => null));
  const seadrop = new Contract(
    SEADROP_ADDRESS,
    [
      "function getSigners(address) view returns (address[])",
      "function getAllowedFeeRecipients(address) view returns (address[])",
    ],
    provider
  );
  const [signers, allowed] = await Promise.all([
    seadrop.getSigners(contract).catch(() => null),
    seadrop.getAllowedFeeRecipients(contract).catch(() => null),
  ]);
  let owner: string | null = null;
  try {
    const token = new Contract(
      getAddress(contract.toLowerCase()),
      ["function name() view returns (string)", "function owner() view returns (address)"],
      provider
    );
    if (name === null) name = ((await token.name().catch(() => null)) as string | null) ?? null;
    owner = ((await token.owner().catch(() => null)) as string | null) ?? null;
  } catch {
    // name and owner are best-effort
  }

  if (!plan) {
    return {
      chainKey: chain.key,
      chainName: chain.name,
      contract,
      slug,
      name,
      owner: null,
      applicable: false,
      notApplicableReason: "no SeaDrop 1.0 public drop found (not SeaDrop, or a newer variant)",
      publicDrop: null,
      feeRecipient: null,
      signerCount: signers ? signers.length : 0,
      allowedFeeRecipientCount: allowed ? allowed.length : 0,
      maxSupply: null,
      totalMinted: 0n,
      walletMints,
      mintScan: EMPTY_SCAN,
      recentWindowMinutes: RECENT_WINDOW_MINUTES,
      sampleMinutes: 0,
      scanCoverage: 0,
      updates: [],
      changes: summarizeChanges([]),
      apiStages: null,
      social: null,
      smartMinters: 0,
      codeHash: null,
      // Deliberately not a letter grade: "not applicable" is not a judgement
      // about the drop, and letting it look like one leaked a "grade B" onto
      // the board and into the executor logs for targets that have no plan.
      grade: {
        grade: "?",
        upperGrade: "?",
        projectedGrade: "?",
        risks: [],
        reason: "not applicable (no SeaDrop public drop)",
        upperReason: "not applicable",
        projectedReason: "not applicable",
      } as unknown as GradeResult,
      errors,
    };
  }

  // ── events ───────────────────────────────────────────────────────────
  const { latestBlock, secondsPerBlock, latestTimestamp } = await estimateBlockTime(rpcUrl);
  // Fractional days are allowed: a scan-triggered audit only needs recent history,
  // and Arc rate-limits long ranges hard.
  const lookbackDays = Math.max(0.05, opts.lookbackDays ?? DEFAULT_LOOKBACK_DAYS);
  const lookbackBlocks = Math.ceil((lookbackDays * 86_400) / secondsPerBlock);
  const fromBlock = Math.max(0, latestBlock - lookbackBlocks);
  const recentFromBlock = Math.max(fromBlock, latestBlock - Math.ceil((RECENT_WINDOW_MINUTES * 60) / secondsPerBlock));
  const paddedContract = "0x" + "0".repeat(24) + contract.slice(2).toLowerCase();
  const blockBefore = (minutes: number): number =>
    Math.max(fromBlock, latestBlock - Math.ceil((minutes * 60) / secondsPerBlock));
  const recent15mFrom = Math.max(fromBlock, recentFromBlock);
  const recent1hFrom = blockBefore(60);

  const cacheDir = opts.cacheDir ?? DEFAULT_CACHE_DIR;
  const cacheTtlMs = opts.cacheTtlMs ?? CACHE_TTL_MS;
  const cached = readCache<CachedPayload>(chain.key, contract, cacheDir);

  let mintScan: MintScan;
  let updates: (DropUpdate & { at: number | null })[];

  if (cached && isFresh(cached, cacheTtlMs)) {
    progress("using cached scan");
    mintScan = deserializeScan(cached.data.mintScan);
    updates = deserializeUpdates(cached.data.updates);
  } else {
    progress(`scanning ${lookbackDays}d of SeaDrop logs...`);
    const [mintLogs, updateLogs] = await Promise.all([
      scanLogs(chain.key, SEADROP_ADDRESS, [SEADROP_MINT_TOPIC, paddedContract], fromBlock, latestBlock, {
        rpcUrls: rpcPlan.urls,
        maxRetries: opts.maxRetries,
        onProgress: progress,
      }),
      scanLogs(chain.key, SEADROP_ADDRESS, [PUBLIC_DROP_UPDATED_TOPIC, paddedContract], fromBlock, latestBlock, {
        rpcUrls: rpcPlan.urls,
        maxRetries: opts.maxRetries,
        onProgress: progress,
      }),
    ]);
    mintScan = aggregateMints(mintLogs, recent15mFrom, [{ label: "1h", fromBlock: recent1hFrom }]);
    const decoded = decodeDropUpdates(updateLogs);
    const times = await fetchBlockTimestamps(rpcUrl, decoded.map((u) => u.block));
    updates = decoded.map((u) => ({ ...u, at: times.get(u.block) ?? null }));
    writeCache<unknown>(
      chain.key,
      contract,
      {
        scannedToBlock: latestBlock,
        scannedAt: Date.now(),
        data: { mintScan: serializeScan(mintScan), updates: serializeUpdates(updates) },
      },
      cacheDir
    );
  }

  // ── optional OpenSea enrichment ──────────────────────────────────────
  let apiStages: ApiStage[] | null = null;
  let social: Social | null = null;
  const key = apiKey();
  if (key) {
    if (!slug) {
      const reverse = await fetchJson(`https://api.opensea.io/api/v2/chain/${chain.key}/contract/${contract}`, key);
      slug = reverse?.collection ?? null;
    }
    if (slug) {
      const [collection, drops] = await Promise.all([
        fetchJson(`https://api.opensea.io/api/v2/collections/${slug}`, key),
        fetchJson(`https://api.opensea.io/api/v2/drops/${slug}`, key),
      ]);
      if (collection) {
        const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
        social = {
          twitter: str(collection.twitter_username),
          discord: str(collection.discord_url),
          website: str(collection.project_url),
          imageUrl: str(collection.image_url),
          createdDate: str(collection.created_date),
          safelist: str(collection.safelist_status),
        };
      } else {
        errors.push("collections API unavailable or rate-limited");
      }
      if (drops?.stages) {
        apiStages = (drops.stages as any[]).map((stage) => ({
          label: String(stage.label ?? stage.stage_type ?? "stage"),
          stageType: String(stage.stage_type ?? ""),
          price: String(stage.price ?? "0"),
          startTime: String(stage.start_time ?? ""),
          endTime: String(stage.end_time ?? ""),
          maxPerWallet: csv(stage.max_per_wallet ?? stage.max_total_mintable_by_wallet),
          allowlistCount: csv(stage.allowlist_wallet_count),
        }));
      } else {
        errors.push("drops API unavailable or rate-limited");
      }
    }
  }

  // ── grading ──────────────────────────────────────────────────────────
  const now = Math.floor(Date.now() / 1000);
  const changes = summarizeChanges(updates);
  const atOf = (block: number | null): number | null =>
    block === null ? null : (updates.find((u) => u.block === block)?.at ?? null);

  const firstMintAt =
    mintScan.firstBlock === null
      ? null
      : ((await fetchBlockTimestamps(rpcUrl, [mintScan.firstBlock])).get(mintScan.firstBlock) ?? null);
  const sampleMinutes = firstMintAt === null ? RECENT_WINDOW_MINUTES : Math.min(RECENT_WINDOW_MINUTES, (latestTimestamp - firstMintAt) / 60);

  const maxSupply = statsZero && statsZero.maxSupply > 0n ? statsZero.maxSupply : null;
  const totalMinted = statsZero?.totalMinted ?? 0n;
  const walletCount = Math.max(1, walletMints.length);
  const requested = BigInt(requestedQuantity * walletCount);
  const minutesToPublic = Math.max(0, (plan.drop.startTime - now) / 60);

  const created = social?.createdDate ? Date.parse(social.createdDate) : NaN;
  const ageHours = Number.isFinite(created) ? (plan.drop.startTime * 1000 - created) / 3_600_000 : null;

  const grade = gradeTarget({
    maxSupply,
    totalMinted,
    requested,
    recentTokens: mintScan.recentTokens,
    recentWindowMinutes: RECENT_WINDOW_MINUTES,
    minutesToPublic,
    rateConfident: isRateConfident(mintScan.recentTokens, sampleMinutes),
    priceChanges: changes.priceChanges,
    startChanges: changes.startChanges,
    lastPriceChangeAt: atOf(changes.lastPriceChangeAtBlock),
    lastStartChangeAt: atOf(changes.lastStartChangeAtBlock),
    publicStartAt: plan.drop.startTime,
    now,
    topMinterShare: mintScan.topMinterShare,
    scanTokens: mintScan.totalTokens,
    scanCoverage: totalMinted > 0n ? Number((mintScan.totalTokens * 10_000n) / totalMinted) / 10_000 : 1,
    socialKnown: social !== null,
    socialAny: social !== null && Boolean(social.twitter || social.discord || social.website),
    ageHours,
  });

  return {
    chainKey: chain.key,
    chainName: chain.name,
    contract,
    slug,
    name,
    owner,
    applicable: true,
    publicDrop: plan.drop,
    feeRecipient: plan.feeRecipient,
    signerCount: signers ? signers.length : 0,
    allowedFeeRecipientCount: allowed ? allowed.length : 0,
    maxSupply,
    totalMinted,
    walletMints,
    mintScan,
    recentWindowMinutes: RECENT_WINDOW_MINUTES,
    sampleMinutes,
    scanCoverage: totalMinted > 0n ? Number((mintScan.totalTokens * 10_000n) / totalMinted) / 10_000 : 1,
    updates,
    changes,
    apiStages,
    social,
    smartMinters: opts.smartSet ? smartOverlap(mintScan.topMinters, opts.smartSet) : 0,
    codeHash,
    grade,
    errors,
  };
}
