// What a "join the queue" click would actually mean.
//
// The panel is the cheapest place to find out: the quantity policy, the
// worst-case spend and the risk labels are all decided from facts the board
// already holds, and two jobs opening within seconds of each other will share a
// wallet, so the operator should see that before queueing, not at T-0.
//
// Pure: the server feeds it the state facts and the current queue, the client
// shows the answer.

import { planReservation } from "../batch-coordinator";
import { freeQuantityFor, gasLimitForQuantity, riskAdjustedQuantity } from "../quantity";

export interface PreviewEntry {
  mintPriceWei: string | null;
  capPerWallet: number | null;
  codeHash: string | null;
  publicStart: number | null;
  applicable?: boolean | null;
  notApplicableReason?: string | null;
}

export interface PreviewInput {
  chain: string;
  contract: string;
  quantity: number;
  startAtMs: number | null;
  entry?: PreviewEntry | null;
  existing: { id: string; chain: string; contract: string; startAtMs: number | null; status: string }[];
  freeMaxQuantity: number;
  gasLimit: number;
  maxFeePerGasWei: string;
  riskFlags: string[];
  conflictWindowMs?: number;
}

export interface PreviewResult {
  ok: boolean;
  reason?: string;
  quantity: number;
  quantityReason: string;
  worstCaseWei: string;
  warnings: string[];
  conflicts: string[];
}

// "What is about to happen" for the whole queue: how many jobs open inside the
// executor's claim window, and how many of those pair up on the same wallet set
// within a few seconds (every job shares the wallets, so that is a real wait).
export function summarizeQueue(
  jobs: { startAtMs: number | null; status: string }[],
  nowMs: number,
  input: { windowMs?: number; conflictWindowMs?: number } = {}
): { dueSoon: number; conflicts: number } {
  const live = jobs.filter((job) => job.status === "queued" || job.status === "claimed");
  const windowMs = input.windowMs ?? 45 * 60_000;
  const due = live
    .filter((job) => job.startAtMs !== null && job.startAtMs - nowMs <= windowMs)
    .map((job) => job.startAtMs!)
    .sort((a, b) => a - b);
  const conflictWindowMs = input.conflictWindowMs ?? 5_000;
  let conflicts = 0;
  for (let i = 0; i + 1 < due.length; i++) {
    if (Math.abs(due[i + 1] - due[i]) <= conflictWindowMs) conflicts++;
  }
  return { dueSoon: due.length, conflicts };
}

export function previewJob(input: PreviewInput): PreviewResult {
  const warnings: string[] = [];
  const entry = input.entry ?? null;

  if (entry && entry.applicable === false) {
    return {
      ok: false,
      reason: entry.notApplicableReason ?? "not a SeaDrop public drop on this chain",
      quantity: input.quantity,
      quantityReason: "not applicable",
      worstCaseWei: "0",
      warnings,
      conflicts: [],
    };
  }

  if (!entry || (entry.mintPriceWei === null && entry.capPerWallet === null)) {
    warnings.push("no on-chain plan yet — the executor audits before signing and will reject a non-SeaDrop target");
  }
  if (entry && entry.codeHash === null) {
    warnings.push("codeHash not pinned yet — gate 1 is skipped until the executor audits it");
  }
  for (const flag of input.riskFlags) {
    if (flag === "instant-sellout") warnings.push("instant-sellout: the public remainder is likely swept by batch contracts");
    if (flag === "batch-mint") warnings.push("batch-mint traces seen: this target may be a clone-contract playground");
  }

  // The same policy the executor applies at T-refresh, on the facts we have.
  let quantity = riskAdjustedQuantity(input.quantity, input.riskFlags);
  let quantityReason = quantity < input.quantity ? `${input.riskFlags.join("/")} target → 1` : "requested quantity";
  if (entry && quantity === input.quantity) {
    const price = entry.mintPriceWei === null ? null : BigInt(entry.mintPriceWei);
    if (price !== null) {
      const policy = freeQuantityFor({
        mintPriceWei: price,
        capPerWallet: entry.capPerWallet ?? 0,
        freeMaxQuantity: input.freeMaxQuantity,
      });
      quantity = policy.quantity;
      quantityReason = policy.reason;
    }
  }

  // Free drops reserve gas only; a paid one also reserves value x tickets. The
  // gas limit grows with the quantity exactly as local-mint grows it.
  const price = entry?.mintPriceWei ? BigInt(entry.mintPriceWei) : 0n;
  const effectiveGasLimit = BigInt(gasLimitForQuantity(input.gasLimit, quantity));
  const worstCaseWei = planReservation({
    value: price * BigInt(quantity),
    gasLimit: effectiveGasLimit,
    maxFeePerGas: BigInt(input.maxFeePerGasWei),
    shots: 1,
  }).toString();

  // Same wallet set for every job: opening times within the window collide.
  const window = input.conflictWindowMs ?? 5_000;
  const conflicts =
    input.startAtMs === null
      ? []
      : input.existing
          .filter((job) => job.status === "queued" || job.status === "claimed")
          .filter((job) => job.startAtMs !== null && Math.abs(job.startAtMs - input.startAtMs!) <= window)
          .map((job) => job.id);

  return { ok: true, quantity, quantityReason, worstCaseWei, warnings, conflicts };
}
