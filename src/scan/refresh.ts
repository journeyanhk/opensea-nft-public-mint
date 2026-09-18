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
    entry.slug === null ||
    entry.slug === undefined ||
    entry.endTime === null ||
    entry.endTime === undefined ||
    entry.totalMinted === null ||
    entry.totalMinted === undefined ||
    entry.name === null ||
    entry.name === undefined
  );
}

export interface RefreshOptions {
  chain?: string;
  limit: number;
  statePath?: string;
  onProgress?: (message: string) => void;
  resolveSlugFn?: (chain: string, contract: string) => Promise<string | null>;
}

export interface RefreshSummary {
  candidates: number;
  processed: number;
  slugsResolved: number;
  factsUpdated: number;
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

// Refreshes up to `limit` entries per invocation; returns what is left so the
// caller can tell the user to run it again.
export async function refreshTargets(opts: RefreshOptions): Promise<RefreshSummary> {
  const statePath = opts.statePath ?? DEFAULT_STATE_PATH;
  const { state, corrupt } = loadState(statePath);
  if (corrupt) throw new Error(`${statePath} is unreadable — fix or remove it first.`);

  const chains = opts.chain ? [opts.chain] : Object.keys(state.contracts);
  const work: { chain: string; contract: string; entry: ContractEntry }[] = [];
  for (const chain of chains) {
    if (!resolveChain(chain)) throw new Error(`Unsupported chain "${chain}"`);
    for (const [contract, entry] of Object.entries(state.contracts[chain] ?? {})) {
      if (needsRefresh(entry)) work.push({ chain, contract, entry });
    }
  }
  work.sort((a, b) => String(a.entry.lastSeenBlock).localeCompare(String(b.entry.lastSeenBlock)));

  const batch = work.slice(0, Math.max(1, opts.limit));
  const progress = opts.onProgress ?? (() => {});
  const rpcByChain = new Map<string, string>();

  let processed = 0;
  let slugsResolved = 0;
  let factsUpdated = 0;
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
      `  candidates ${summary.candidates} | processed ${summary.processed} | slugs +${summary.slugsResolved} | facts +${summary.factsUpdated} | errors ${summary.errors}`
    )
  );
  if (summary.remaining > 0) {
    console.log(chalk.bold(`  ${summary.remaining} still need refreshing — run this command again`));
  } else {
    console.log(chalk.green("  all entries have slug, name and facts"));
  }
}
