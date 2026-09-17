// Batch mode: turn a targets.json file into an ordered list of public-mint targets.
//
// Each target is resolved and read from the chain once here — enough to clamp the
// quantity to the on-chain cap, budget gas and print a schedule. Price and start
// time are re-read at fire time by local-mint, so a stale value in the config can
// never be what actually gets signed.

import chalk from "chalk";
import { formatEther, parseEther, parseUnits } from "ethers";
import { ChainProfile, resolveChain } from "./chains";
import { resolveSlug } from "./slug-resolver";
import { parseNftLink } from "./nft-link";
import { buildLocalMintPlan, fetchMintStats, fetchPublicDrop, LocalMintPlan } from "./seadrop-public";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export interface BatchTarget {
  label: string;
  contract: string;
  quantity: number;
  maxValueWei: bigint; // ceiling for mintPrice × quantity, per wallet
  startAt: Date;
  plan: LocalMintPlan;
  supply: { totalMinted: bigint; maxSupply: bigint } | null; // null when the contract cannot answer
}

export interface BatchConfig {
  chainKey: string;
  walletSource: "env" | "prompt";
  rpcUrls: string[];
  maxFeePerGas: bigint;
  maxPriorityFee: bigint;
  gasLimit: number;
  refreshBeforeMs: number;
  onFailure: "continue" | "stop";
  targets: BatchTarget[];
}

const DEFAULT_GAS_LIMIT = 250_000;
const DEFAULT_REFRESH_MS = 3_000;

// SeaDrop reports an unset per-wallet cap as 0, which means "no limit" rather
// than "mint nothing".
export function clampQuantity(quantity: number, maxTotalMintableByWallet: number): number {
  const wanted = Number.isFinite(quantity) && quantity >= 1 ? Math.floor(quantity) : 1;
  if (maxTotalMintableByWallet > 0 && wanted > maxTotalMintableByWallet) {
    return maxTotalMintableByWallet;
  }
  return wanted;
}

export function computeMaxValueWei(
  maxPriceEth: string | number | undefined,
  quantity: number
): bigint {
  return parseEther(String(maxPriceEth ?? "0")) * BigInt(quantity);
}

export function sortTargetsByStart(targets: BatchTarget[]): BatchTarget[] {
  return [...targets].sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
}

// Gas defaults mirror the wizard's, so a batch and a manual run of the same
// target can only disagree when the config overrides them on purpose.
export function resolveGas(
  chainKey: string,
  override: { maxFeeGwei?: number; priorityGwei?: number; gasLimit?: number } = {}
): { maxFeePerGas: bigint; maxPriorityFee: bigint; gasLimit: number } {
  const profile = resolveChain(chainKey);
  // Empty .env entries must fall through to the chain defaults, and a 0 tip is a
  // valid value (Arc suggests exactly that), so `||` cannot be used here.
  const feeEnv = (process.env.MAX_FEE_PER_GAS || "").trim();
  const priorityEnv = (process.env.MAX_PRIORITY_FEE || "").trim();
  const envMaxFee = feeEnv ? Number(feeEnv) : profile?.gas.maxFeeGwei ?? 2;
  const envPriority = priorityEnv ? Number(priorityEnv) : profile?.gas.priorityGwei ?? 0.05;
  const envGasLimit = parseInt(process.env.GAS_LIMIT || "0", 10) || DEFAULT_GAS_LIMIT;

  const maxFeeGwei = override.maxFeeGwei ?? envMaxFee;
  const priorityGwei = override.priorityGwei ?? envPriority;
  const gasLimit = override.gasLimit ?? envGasLimit;

  const maxFeePerGas = parseUnits(String(maxFeeGwei), "gwei");
  const maxPriorityFee = parseUnits(String(priorityGwei), "gwei");
  if (maxPriorityFee > maxFeePerGas) {
    throw new Error(
      `gas.priorityGwei (${priorityGwei}) cannot exceed gas.maxFeeGwei (${maxFeeGwei}).`
    );
  }
  return { maxFeePerGas, maxPriorityFee, gasLimit };
}

function nonNegativeInt(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

// The file is parsed by the caller so the chain — and therefore the RPC list —
// is known before the network-bound part of the load starts.
export async function loadBatchConfig(
  raw: any,
  chain: ChainProfile,
  rpcUrls: string[]
): Promise<BatchConfig> {
  if (rpcUrls.length === 0) {
    throw new Error("No usable RPC endpoint — the batch would have nothing to send through.");
  }
  if (!Array.isArray(raw?.targets) || raw.targets.length === 0) {
    throw new Error("The batch config lists no targets.");
  }

  const apiKey = (process.env.OPENSEA_API_KEY || "").trim() || undefined;
  const targets: BatchTarget[] = [];

  for (const [index, entry] of raw.targets.entries()) {
    const where = `target #${index + 1}`;
    if (entry?.slug === undefined || entry?.slug === null || String(entry.slug).trim() === "") {
      throw new Error(`${where} is missing "slug".`);
    }

    const input = String(entry.slug);
    let contract: string;
    let label: string;
    let targetChain = chain.key;

    let link;
    try {
      link = parseNftLink(input);
    } catch (err) {
      throw new Error(`${where} (${input}): ${(err as Error).message}`);
    }

    if (link.kind === "address") {
      contract = link.value;
      label = link.value;
      const hint = link.chainHint ? resolveChain(link.chainHint) : undefined;
      if (hint) targetChain = hint.key;
    } else {
      console.log(chalk.gray(`  Resolving ${link.value}...`));
      const info = await resolveSlug(link.value, apiKey, chain.key);
      contract = info.contractAddress;
      label = info.name || link.value;
      const on = info.chain ? resolveChain(info.chain) : undefined;
      if (on) targetChain = on.key;
    }

    if (targetChain !== chain.key) {
      const other = resolveChain(targetChain)?.name ?? targetChain;
      throw new Error(
        `${where} (${input}) resolves on ${other}, but the batch is pinned to ${chain.name}. Split it into two configs.`
      );
    }

    const drop = await fetchPublicDrop(rpcUrls[0], contract);
    if (!drop) {
      throw new Error(
        `${where} (${input}) has no SeaDrop 1.0 public drop for ${contract} — batch mode only handles on-chain public stages.`
      );
    }

    const requested = entry.quantity === undefined ? 1 : Number(entry.quantity);
    const quantity = clampQuantity(requested, drop.maxTotalMintableByWallet);
    if (quantity !== requested) {
      console.log(
        chalk.yellow(
          `  ${label}: quantity ${requested} → ${quantity} (on-chain per-wallet cap ${drop.maxTotalMintableByWallet})`
        )
      );
    }

    const plan = await buildLocalMintPlan(rpcUrls[0], contract, quantity);
    if (!plan) {
      throw new Error(`${where} (${input}) could not be built into a public mint plan.`);
    }

    const maxValueWei = computeMaxValueWei(entry.maxPriceEth, quantity);
    if (entry.maxPriceEth === undefined) {
      if (plan.value > 0n) {
        throw new Error(
          `${where} (${input}) is priced ${formatEther(plan.drop.mintPrice)} per NFT — set "maxPriceEth" to the most you are willing to pay.`
        );
      }
    } else if (plan.value > maxValueWei) {
      console.log(
        chalk.yellow(
          `  ${label}: current total ${formatEther(plan.value)} is above the maxPriceEth cap ${formatEther(maxValueWei)} — it will be skipped unless the price drops.`
        )
      );
    }

    const startAt =
      entry.startAt === undefined || entry.startAt === "auto"
        ? new Date(plan.drop.startTime * 1000)
        : new Date(String(entry.startAt));
    if (Number.isNaN(startAt.getTime())) {
      throw new Error(`${where} (${input}): "startAt" must be "auto" or an ISO timestamp.`);
    }

    // Global supply only — the per-wallet count is checked at fire time, when the
    // wallet set is known. A contract that cannot answer simply reports null.
    const stats = await fetchMintStats(rpcUrls[0], contract, ZERO_ADDRESS);

    targets.push({
      label,
      contract,
      quantity,
      maxValueWei,
      startAt,
      plan,
      supply: stats ? { totalMinted: stats.totalMinted, maxSupply: stats.maxSupply } : null,
    });
  }

  return {
    chainKey: chain.key,
    walletSource: raw.walletSource === "prompt" ? "prompt" : "env",
    rpcUrls,
    ...resolveGas(chain.key, raw.gas ?? {}),
    refreshBeforeMs: nonNegativeInt(raw.refreshBeforeMs, DEFAULT_REFRESH_MS),
    onFailure: raw.onFailure === "stop" ? "stop" : "continue",
    targets: sortTargetsByStart(targets),
  };
}
