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
import { ContractEntry, ScanState, loadState, saveState, DEFAULT_STATE_PATH } from "./state";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const CONCURRENCY = 3;

export function needsRefresh(entry: ContractEntry): boolean {
  return (
    entry.slug == null ||
    entry.name == null ||
    entry.endTime == null ||
    entry.totalMinted == null ||
    entry.owner == null ||
    // A known slug whose collection has not been read yet still needs one pass;
    // `socialCheckedAt` is set even when the collection has no socials at all.
    (entry.slug != null && entry.socialCheckedAt == null)
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

async function fetchXFollowers(handle: string): Promise<number | null> {
  try {
    const res = await fetch(`https://api.fxtwitter.com/${encodeURIComponent(handle.replace(/^@/, ""))}`);
    if (!res.ok) return null;
    const json = (await res.json()) as { user?: { followers?: unknown } };
    const followers = json?.user?.followers;
    return typeof followers === "number" && Number.isFinite(followers) ? followers : null;
  } catch {
    return null;
  }
}

export interface RefreshOptions {
  chain?: string;
  limit: number;
  statePath?: string;
  onProgress?: (message: string) => void;
  resolveSlugFn?: (chain: string, contract: string) => Promise<string | null>;
  collectionFn?: (slug: string) => Promise<CollectionFacts | null>;
  xEnabled?: boolean;
}

export interface RefreshSummary {
  candidates: number;
  processed: number;
  slugsResolved: number;
  factsUpdated: number;
  socialsUpdated: number;
  xUpdated: number;
  errors: number;
  remaining: number;
}

function apiKey(): string | null {
  const key = (process.env.OPENSEA_API_KEY || "").trim();
  return key.length > 0 ? key : null;
}

async function reverseSlug(chain: string, contract: string): Promise<string | null> {
  const key = apiKey();
  if (!key) return null;
  try {
    const res = await fetch(`https://api.opensea.io/api/v2/chain/${chain}/contract/${contract}`, {
      headers: { accept: "application/json", "x-api-key": key },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { collection?: string };
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
async function fetchCollection(slug: string): Promise<CollectionFacts | null> {
  try {
    const key = apiKey();
    const res = await fetch(`https://api.opensea.io/api/v2/collections/${encodeURIComponent(slug)}`, {
      headers: key ? { accept: "application/json", "x-api-key": key } : { accept: "application/json" },
    });
    if (res.status === 404) return socialFromCollection(null);
    if (!res.ok) return null;
    return socialFromCollection(await res.json());
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
      if (needsRefresh(entry) || xMetricsDue(entry, nowSec, xEnabled)) work.push({ chain, contract, entry });
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
  let errors = 0;

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
      try {
        const rpc = await getRpc(chain);
        if (!rpc) {
          errors++;
          continue;
        }

        const plan = await buildLocalMintPlan(rpc, contract, 1);
        const stats = await fetchMintStats(rpc, contract, ZERO_ADDRESS);
        if (plan) {
          entry.publicStart = plan.drop.startTime;
          entry.endTime = plan.drop.endTime;
        }
        if (stats) {
          entry.maxSupply = stats.maxSupply > 0n ? stats.maxSupply.toString() : null;
          entry.totalMinted = stats.totalMinted.toString();
        }
        if (plan || stats) factsUpdated++;

        if (entry.slug === null || entry.slug === undefined) {
          const slug = opts.resolveSlugFn
            ? await opts.resolveSlugFn(chain, contract)
            : await reverseSlug(chain, contract);
          if (slug) {
            entry.slug = slug;
            slugsResolved++;
          }
        }
        if (entry.name === null || entry.name === undefined) {
          entry.name = await readName(rpc, contract);
        }
        if (entry.owner === null || entry.owner === undefined) {
          entry.owner = await readOwner(rpc, contract);
        }

        const collectionFn = opts.collectionFn ?? fetchCollection;
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
            socialsUpdated++;
          }
        }

        if (xMetricsDue(entry, Math.floor(Date.now() / 1000), xEnabled) && entry.twitter) {
          const followers = await fetchXFollowers(entry.twitter);
          if (followers !== null) {
            entry.xFollowers = followers;
            entry.xCheckedAt = new Date().toISOString();
            xUpdated++;
          }
        }
        processed++;
      } catch (err) {
        errors++;
        progress(`${chain}/${contract}: ${(err as Error).message}`);
      }
      if (processed % 25 === 0) saveState(state, statePath);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batch.length) }, worker));

  saveState(state, statePath);
  return {
    candidates: work.length,
    processed,
    slugsResolved,
    factsUpdated,
    socialsUpdated,
    xUpdated,
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
  if (summary.remaining > 0) {
    console.log(chalk.bold(`  ${summary.remaining} still need refreshing — run this command again`));
  } else {
    console.log(chalk.green("  all entries have slug, name, facts and socials"));
  }
}
