// One-time (and periodic) state refresh: resolve each contract's OpenSea slug,
// name and cheap on-chain facts so the dashboard can classify and link targets
// without waiting for a full audit.
//
// Cheap by design: buildLocalMintPlan (drop + fee recipient) and getMintStats are
// two reads per contract, and the slug lookup happens at most once per contract
// for its lifetime. Idempotent: entries that already have the fields are skipped,
// so the command can be re-run until the backlog is cleared.

import chalk from "chalk";
import { Contract, JsonRpcProvider, getAddress } from "ethers";
import { resolveChain } from "../chains";
import { planRpcs, resolveScanRpcs } from "../rpc-resolver";
import { buildLocalMintPlan, fetchMintStats } from "../seadrop-public";
import { resolveSlug } from "../slug-resolver";
import { ContractEntry, ScanState, loadState, saveStateMerged, StatePatch, DEFAULT_STATE_PATH } from "./state";
import { applyPlanFacts } from "./price-watch";

// An open target with no new events never re-entered any refresh path, so its
// price could sit at the discovery snapshot forever (projects flip free -> paid
// seconds after the open). Public terms are cheap to re-read: two calls, no log
// scan.
const PRICE_REFRESH_HOURS = 6;

function priceStale(entry: ContractEntry, nowMs: number): boolean {
  if (entry.publicStart === null || entry.publicStart * 1000 > nowMs) return false; // not open yet: audits handle it
  if (entry.endTime !== null && entry.endTime * 1000 <= nowMs) return false; // closed
  if (entry.soldOutAtBlock !== null) return false; // nothing left to watch
  const at = entry.factsAt ? Date.parse(entry.factsAt) : NaN;
  return !Number.isFinite(at) || nowMs - at > PRICE_REFRESH_HOURS * 3_600_000;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const CONCURRENCY = 3;
const REQUEST_TIMEOUT_MS = 15_000;

// A 900-contract migration is thousands of OpenSea requests; a free key allows
// only a few per second, so every call goes through one shared limiter and a
// 429 is retried once (honouring retry-after) instead of being read as "no data".
export interface LimiterDeps {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class RateLimiter {
  private nextAt = 0;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly rps: number, deps: LimiterDeps = {}) {
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async acquire(): Promise<void> {
    const interval = this.rps > 0 ? 1000 / this.rps : 0;
    const at = this.now();
    const wait = Math.max(0, this.nextAt - at);
    this.nextAt = Math.max(at, this.nextAt) + interval;
    if (wait > 0) await this.sleep(wait);
  }
}

let sharedLimiter: RateLimiter | null = null;

function defaultLimiter(): RateLimiter {
  const configured = Number(process.env.OPENSEA_RPS);
  const rps = Number.isFinite(configured) && configured > 0 ? configured : 2;
  return (sharedLimiter ??= new RateLimiter(rps));
}

export interface LimitedFetchDeps {
  fetchFn?: (url: string, init: RequestInit) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
  limiter?: { acquire(): Promise<void> };
  timeoutMs?: number;
}

export interface LimitedFetchResult {
  response: Response | null;
  rateLimited: boolean;
}

export async function limitedFetch(url: string, init: RequestInit, deps: LimitedFetchDeps = {}): Promise<LimitedFetchResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = deps.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const fetchFn = deps.fetchFn ?? ((target: string, options: RequestInit) => fetch(target, options));

  for (let attempt = 0; attempt < 2; attempt++) {
    await deps.limiter?.acquire();
    let response: Response;
    try {
      response = await fetchFn(url, { ...init, signal: init.signal ?? AbortSignal.timeout(timeoutMs) });
    } catch {
      if (attempt === 1) return { response: null, rateLimited: false };
      continue;
    }
    if (response.status !== 429) return { response, rateLimited: false };
    if (attempt === 1) return { response: null, rateLimited: true };
    const retryAfter = Number(response.headers?.get?.("retry-after"));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 15_000) : 5_000;
    await sleep(waitMs);
  }
  return { response: null, rateLimited: false };
}

interface OpenSeaCallDeps {
  limiter?: { acquire(): Promise<void> };
  onRateLimited?: () => void;
}

export function needsRefresh(entry: ContractEntry): boolean {
  return (
    entry.slug == null ||
    entry.name == null ||
    entry.endTime == null ||
    entry.totalMinted == null ||
    entry.owner == null ||
    // A known slug whose collection has not been read yet still needs one pass;
    // `socialCheckedAt` is set even when the collection has no socials at all.
    (entry.slug != null && entry.socialCheckedAt == null) ||
    // Open, unsold, and the public terms have not been read for a while: this is
    // how a free -> paid flip after the open eventually reaches the board.
    priceStale(entry, Date.now())
  );
}

// Identity and social fields, read once per collection (they change rarely).
export interface CollectionFacts {
  imageUrl: string | null;
  twitter: string | null;
  discord: string | null;
  website: string | null;
  createdDate: string | null;
  safelist: string | null;
}

export function socialFromCollection(collection: unknown): CollectionFacts {
  const raw = (collection ?? {}) as Record<string, unknown>;
  const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
  return {
    imageUrl: str(raw.image_url),
    twitter: str(raw.twitter_username),
    discord: str(raw.discord_url),
    website: str(raw.project_url),
    createdDate: str(raw.created_date),
    safelist: str(raw.safelist_status),
  };
}

// X follower counts are opt-in (ENABLE_X_METRICS=1) and cached for a day; a
// missing handle, a failure or a rate limit simply leaves the field empty.
export function xMetricsDue(entry: ContractEntry, nowSec: number, enabled: boolean): boolean {
  if (!enabled || !entry.twitter) return false;
  if (!entry.xCheckedAt) return true;
  const at = Date.parse(entry.xCheckedAt);
  return !Number.isFinite(at) || nowSec - at / 1000 > 86_400;
}

async function fetchXFollowers(handle: string, deps: OpenSeaCallDeps = {}): Promise<number | null> {
  const { response, rateLimited } = await limitedFetch(
    `https://api.fxtwitter.com/${encodeURIComponent(handle.replace(/^@/, ""))}`,
    { headers: { accept: "application/json" } },
    { limiter: deps.limiter, timeoutMs: 10_000 }
  );
  if (rateLimited) deps.onRateLimited?.();
  if (!response || !response.ok) return null;
  try {
    const json = (await response.json()) as { user?: { followers?: unknown } };
    const followers = json?.user?.followers;
    return typeof followers === "number" && Number.isFinite(followers) ? followers : null;
  } catch {
    return null;
  }
}

export interface RefreshOptions {
  chain?: string;
  limit: number;
  forcePlan?: boolean; // re-read public terms for open targets even if fresh
  statePath?: string;
  onProgress?: (message: string) => void;
  resolveSlugFn?: (chain: string, contract: string) => Promise<string | null>;
  collectionFn?: (slug: string) => Promise<CollectionFacts | null>;
  limiter?: { acquire(): Promise<void> };
  xEnabled?: boolean;
}

export interface RefreshSummary {
  candidates: number;
  processed: number;
  slugsResolved: number;
  factsUpdated: number;
  socialsUpdated: number;
  xUpdated: number;
  rateLimited: number;
  errors: number;
  remaining: number;
}

function apiKey(): string | null {
  const key = (process.env.OPENSEA_API_KEY || "").trim();
  return key.length > 0 ? key : null;
}

async function reverseSlug(chain: string, contract: string, deps: OpenSeaCallDeps = {}): Promise<string | null> {
  const key = apiKey();
  if (!key) return null;
  const { response, rateLimited } = await limitedFetch(`https://api.opensea.io/api/v2/chain/${chain}/contract/${contract}`, {
    headers: { accept: "application/json", "x-api-key": key },
  }, { limiter: deps.limiter });
  if (rateLimited) deps.onRateLimited?.();
  if (!response || !response.ok) return null;
  try {
    const json = (await response.json()) as { collection?: string };
    return json.collection ?? null;
  } catch {
    return null;
  }
}

async function readName(rpcUrl: string, contract: string): Promise<string | null> {
  try {
    const provider = new JsonRpcProvider(rpcUrl);
    const token = new Contract(getAddress(contract.toLowerCase()), ["function name() view returns (string)"], provider);
    return ((await token.name().catch(() => null)) as string | null) ?? null;
  } catch {
    return null;
  }
}

async function readOwner(rpcUrl: string, contract: string): Promise<string | null> {
  try {
    const provider = new JsonRpcProvider(rpcUrl);
    const token = new Contract(getAddress(contract.toLowerCase()), ["function owner() view returns (address)"], provider);
    return ((await token.owner().catch(() => null)) as string | null) ?? null;
  } catch {
    return null;
  }
}

// The collections endpoint is readable without a key, so socials and the image
// arrive even on a keyless box. A 404 is authoritative (nothing to read, stop
// asking); a rate limit or a network blip returns null and is retried later.
async function fetchCollection(slug: string, deps: OpenSeaCallDeps = {}): Promise<CollectionFacts | null> {
  const key = apiKey();
  const { response, rateLimited } = await limitedFetch(
    `https://api.opensea.io/api/v2/collections/${encodeURIComponent(slug)}`,
    { headers: key ? { accept: "application/json", "x-api-key": key } : { accept: "application/json" } },
    { limiter: deps.limiter }
  );
  if (rateLimited) deps.onRateLimited?.();
  if (!response) return null;
  if (response.status === 404) return socialFromCollection(null); // authoritative: nothing to read
  if (!response.ok) return null; // rate limit / network: retry next run
  try {
    return socialFromCollection(await response.json());
  } catch {
    return null;
  }
}

// Refreshes up to `limit` entries per invocation; returns what is left so the
// caller can tell the user to run it again.
export async function refreshTargets(opts: RefreshOptions): Promise<RefreshSummary> {
  const statePath = opts.statePath ?? DEFAULT_STATE_PATH;
  const { state, corrupt } = loadState(statePath);
  if (corrupt) throw new Error(`${statePath} is unreadable — fix or remove it first.`);

  const chains = opts.chain ? [opts.chain] : Object.keys(state.contracts);
  const nowSec = Math.floor(Date.now() / 1000);
  const xEnabled = opts.xEnabled ?? (process.env.ENABLE_X_METRICS || "").trim() === "1";
  const work: { chain: string; contract: string; entry: ContractEntry }[] = [];
  for (const chain of chains) {
    if (!resolveChain(chain)) throw new Error(`Unsupported chain "${chain}"`);
    for (const [contract, entry] of Object.entries(state.contracts[chain] ?? {})) {
      const openNow =
        entry.publicStart !== null &&
        entry.publicStart <= nowSec &&
        (entry.endTime === null || entry.endTime > nowSec) &&
        entry.soldOutAtBlock === null;
      if (needsRefresh(entry) || xMetricsDue(entry, nowSec, xEnabled) || (opts.forcePlan === true && openNow)) {
        work.push({ chain, contract, entry });
      }
    }
  }
  work.sort((a, b) => String(a.entry.lastSeenBlock).localeCompare(String(b.entry.lastSeenBlock)));

  const batch = work.slice(0, Math.max(1, opts.limit));
  const progress = opts.onProgress ?? (() => {});
  const rpcByChain = new Map<string, string>();

  let processed = 0;
  let slugsResolved = 0;
  let factsUpdated = 0;
  let socialsUpdated = 0;
  let xUpdated = 0;
  let rateLimited = 0;
  let errors = 0;

  const limiter = opts.limiter ?? defaultLimiter();
  const onRateLimited = (): void => {
    rateLimited++;
  };
  const collectionFn = opts.collectionFn ?? ((slug: string) => fetchCollection(slug, { limiter, onRateLimited }));
  const slugFn =
    opts.resolveSlugFn ?? ((chain: string, contract: string) => reverseSlug(chain, contract, { limiter, onRateLimited }));
  // Only the fields actually refreshed are written back, merged into whatever is
  // on disk, so a scan running at the same time cannot be overwritten.
  const patches: StatePatch["contracts"] = {};
  const flush = (): void => saveStateMerged({ contracts: patches }, statePath);

  const getRpc = async (chain: string): Promise<string | null> => {
    if (rpcByChain.has(chain)) return rpcByChain.get(chain)!;
    const { urls } = resolveScanRpcs(chain);
    const plan = await planRpcs(urls, resolveChain(chain)!.chainId);
    const rpc = plan.urls[0] ?? null;
    if (rpc) rpcByChain.set(chain, rpc);
    return rpc;
  };

  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= batch.length) return;
      const { chain, contract, entry } = batch[index];
      const patch: Partial<ContractEntry> = {};
      try {
        const rpc = await getRpc(chain);
        if (!rpc) {
          errors++;
          continue;
        }

        const plan = await buildLocalMintPlan(rpc, contract, 1);
        const stats = await fetchMintStats(rpc, contract, ZERO_ADDRESS);
        if (plan) {
          const at = new Date().toISOString();
          const { priceChanged } = applyPlanFacts(entry, plan.drop, plan.feeRecipient, at);
          if (priceChanged) {
            progress(`${chain}/${contract}: public price changed to ${entry.mintPriceWei} wei (cap ${entry.capPerWallet ?? "unlimited"})`);
          }
          patch.publicStart = entry.publicStart;
          patch.endTime = entry.endTime;
          patch.mintPriceWei = entry.mintPriceWei;
          patch.capPerWallet = entry.capPerWallet;
          patch.feeRecipient = entry.feeRecipient;
          patch.factsAt = entry.factsAt;
          patch.mintPriceChangedAt = entry.mintPriceChangedAt;
          patch.priceHistory = entry.priceHistory;
        }
        if (stats) {
          entry.maxSupply = stats.maxSupply > 0n ? stats.maxSupply.toString() : null;
          entry.totalMinted = stats.totalMinted.toString();
          patch.maxSupply = entry.maxSupply;
          patch.totalMinted = entry.totalMinted;
        }
        if (plan || stats) factsUpdated++;

        if (entry.slug === null || entry.slug === undefined) {
          const slug = await slugFn(chain, contract);
          if (slug) {
            entry.slug = slug;
            patch.slug = slug;
            slugsResolved++;
          }
        }
        if (entry.name === null || entry.name === undefined) {
          entry.name = await readName(rpc, contract);
          if (entry.name) patch.name = entry.name;
        }
        if (entry.owner === null || entry.owner === undefined) {
          entry.owner = await readOwner(rpc, contract);
          if (entry.owner) patch.owner = entry.owner;
        }

        if (entry.slug && entry.socialCheckedAt == null) {
          const facts = await collectionFn(entry.slug);
          if (facts) {
            entry.imageUrl = facts.imageUrl;
            entry.twitter = facts.twitter;
            entry.discord = facts.discord;
            entry.website = facts.website;
            entry.createdDate = facts.createdDate;
            entry.safelist = facts.safelist;
            entry.socialCheckedAt = new Date().toISOString();
            Object.assign(patch, {
              imageUrl: facts.imageUrl,
              twitter: facts.twitter,
              discord: facts.discord,
              website: facts.website,
              createdDate: facts.createdDate,
              safelist: facts.safelist,
              socialCheckedAt: entry.socialCheckedAt,
            });
            socialsUpdated++;
          }
        }

        if (xMetricsDue(entry, Math.floor(Date.now() / 1000), xEnabled) && entry.twitter) {
          const followers = await fetchXFollowers(entry.twitter, { limiter, onRateLimited });
          if (followers !== null) {
            entry.xFollowers = followers;
            entry.xCheckedAt = new Date().toISOString();
            patch.xFollowers = followers;
            patch.xCheckedAt = entry.xCheckedAt;
            xUpdated++;
          }
        }
        (patches[chain] ??= {})[contract.toLowerCase()] = patch;
        processed++;
      } catch (err) {
        errors++;
        progress(`${chain}/${contract}: ${(err as Error).message}`);
      }
      if (processed % 25 === 0) flush();
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batch.length) }, worker));

  flush();
  return {
    candidates: work.length,
    processed,
    slugsResolved,
    factsUpdated,
    socialsUpdated,
    xUpdated,
    rateLimited,
    errors,
    remaining: Math.max(0, work.length - processed),
  };
}

export function parseRefreshArgs(args: string[]): RefreshOptions {
  const index = args.indexOf("--refresh-targets");
  const rest = args.slice(index + 1);
  const parsed: RefreshOptions = { limit: 200 };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--limit") parsed.limit = Math.max(1, parseInt(rest[++i] ?? "200", 10) || 200);
    else if (arg === "--chain") parsed.chain = rest[++i];
    else if (arg === "--state") parsed.statePath = rest[++i];
    else if (arg === "--force-plan") parsed.forcePlan = true;
    else if (arg.startsWith("--")) throw new Error(`Unknown option "${arg}"`);
  }
  return parsed;
}

export async function runRefreshCommand(args: string[]): Promise<void> {
  const opts = parseRefreshArgs(args);
  if (!apiKey()) {
    console.log(chalk.yellow("  OPENSEA_API_KEY is not set — slugs will be skipped (facts still refresh)"));
  }
  console.log(chalk.bold.cyan(`\nRefresh targets — limit ${opts.limit}${opts.chain ? `, chain ${opts.chain}` : ""}`));
  const summary = await refreshTargets({
    ...opts,
    onProgress: (message) => console.log(chalk.yellow(`  ⚠ ${message}`)),
  });
  console.log(
    chalk.gray(
      `  candidates ${summary.candidates} | processed ${summary.processed} | slugs +${summary.slugsResolved} | facts +${summary.factsUpdated} | socials +${summary.socialsUpdated} | x +${summary.xUpdated} | errors ${summary.errors}`
    )
  );
  if (summary.rateLimited > 0) {
    console.log(
      chalk.yellow(
        `  OpenSea rate-limited ${summary.rateLimited} request(s) — lower OPENSEA_RPS (now ${process.env.OPENSEA_RPS ?? "2"}) or retry later`
      )
    );
  }
  if (summary.remaining > 0) {
    console.log(chalk.bold(`  ${summary.remaining} still need refreshing — run this command again`));
  } else {
    console.log(chalk.green("  all entries have slug, name, facts and socials"));
  }
}
