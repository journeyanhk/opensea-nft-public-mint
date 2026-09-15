// Public-mint execution with no OpenSea in the loop.
//
// Because the calldata is known ahead of time (see seadrop-public.ts), every
// transaction can be signed and serialised close to the stage opening. At T-0 the
// only work left is writing bytes to sockets — no API poll, no encoding.
//
// Batch mode passes refreshBeforeMs, which moves signing to T-refresh: the drop
// is re-read from the chain then, so a price or schedule change made by the
// creator after the batch was configured is adopted (or refused) instead of
// being signed blindly.

import chalk from "chalk";
import { performance } from "perf_hooks";
import { JsonRpcProvider, Wallet, formatEther } from "ethers";
import { blastToAll, parseRpcEndpoints, prepareBlast, waitForReceipt, PreparedBlast } from "./rpc-blast";
import { warmConnections } from "./connection-warmer";
import { waitForMintTime } from "./timer";
import { explorerTx } from "./chains";
import { toUtc8Time } from "./time-format";
import { buildLocalMintPlan, LocalMintPlan } from "./seadrop-public";

export interface LocalSnipeOpts {
  nftContract: string;
  quantity: number;
  walletKeys: string[];
  rpcUrls: string[];
  maxFeePerGas: bigint;
  maxPriorityFee: bigint;
  gasLimit: number;
  targetStart: Date | null;
  plan: LocalMintPlan;
  maxValueWei?: bigint; // refuse to send when the fresh total exceeds this
  refreshBeforeMs?: number; // re-read the drop this long before the stage opens
}

export type SnipeStatus = "SUCCESS" | "REVERTED" | "TIMEOUT" | "REJECTED" | "SKIPPED";

export interface SnipeResult {
  idx: number;
  address: string;
  txHash: string | null;
  status: SnipeStatus;
}

// A postponed start is adopted at most this many times before we stop re-waiting.
const MAX_START_MOVES = 2;

// Reconcile the start time we planned to fire at against the one the chain now
// reports. A creator can still move it after the batch was configured, so the
// plan has to follow: a later opening is waited for again, an earlier one is
// fired as soon as the chain allows. `plannedMs === null` means the batch
// reached this target with the stage apparently already open.
export function reconcileStart(
  plannedMs: number | null,
  chainStartMs: number,
  nowMs: number,
  round: number
): { startMs: number | null; rewait: boolean } {
  const reference = plannedMs ?? nowMs;
  if (chainStartMs > reference + 1000) {
    return { startMs: chainStartMs, rewait: round < MAX_START_MOVES };
  }
  if (plannedMs !== null && chainStartMs < plannedMs - 1000) {
    return { startMs: Math.max(chainStartMs, nowMs), rewait: false };
  }
  return { startMs: plannedMs, rewait: false };
}

export async function localPublicSnipe(opts: LocalSnipeOpts): Promise<SnipeResult[]> {
  const {
    nftContract, quantity, walletKeys, rpcUrls,
    maxFeePerGas, maxPriorityFee, gasLimit, plan, maxValueWei,
  } = opts;

  const refreshMs = opts.refreshBeforeMs ?? 0;
  let targetStart = opts.targetStart;
  let planNow = plan;

  const provider = new JsonRpcProvider(rpcUrls[0]);
  const endpoints = parseRpcEndpoints(rpcUrls);
  const wallets = walletKeys.map((k) => new Wallet(k, provider));

  const skipped = (): SnipeResult[] =>
    wallets.map((w, i) => ({ idx: i, address: w.address, txHash: null, status: "SKIPPED" as const }));

  console.log(chalk.bold.magenta("\n── LOCAL PUBLIC MINT (no OpenSea) ──"));
  console.log(chalk.gray(`  SeaDrop:       ${planNow.to}`));
  console.log(chalk.gray(`  NFT:           ${nftContract}`));
  console.log(chalk.gray(`  Fee recipient: ${planNow.feeRecipient}`));
  console.log(
    chalk.gray(
      `  Price:         ${formatEther(planNow.drop.mintPrice)} × ${quantity} = ${formatEther(planNow.value)} per wallet`
    )
  );
  console.log(chalk.gray(`  Calldata:      ${(planNow.data.length - 2) / 2} bytes (identical for all wallets)`));
  if (maxValueWei !== undefined) {
    console.log(chalk.gray(`  Max total:     ${formatEther(maxValueWei)} per wallet`));
  }

  // ── Warm sockets before the refresh window, so it only has to cover reads ──
  await warmConnections(rpcUrls);

  if (refreshMs > 0) {
    for (let round = 0; ; round++) {
      // Wait until T-refresh (or immediately when the stage is already live).
      if (targetStart && targetStart.getTime() > Date.now()) {
        await waitForMintTime(targetStart, refreshMs);
      }

      const fresh = await buildLocalMintPlan(rpcUrls[0], nftContract, quantity);
      if (!fresh) {
        console.log(chalk.bold.red("  ✗ The public drop is no longer readable on-chain — skipping this target."));
        return skipped();
      }

      const movedTo = fresh.drop.startTime * 1000;
      const decision = reconcileStart(
        targetStart ? targetStart.getTime() : null,
        movedTo,
        Date.now(),
        round
      );

      if (decision.rewait) {
        console.log(
          chalk.bold.yellow(`  ⚠ Public start moved to ${toUtc8Time(new Date(decision.startMs as number))} UTC+8 — re-anchoring.`)
        );
        targetStart = new Date(decision.startMs as number);
        planNow = fresh;
        continue;
      }

      const plannedMs = targetStart ? targetStart.getTime() : null;
      if (decision.startMs !== null && decision.startMs !== plannedMs) {
        console.log(
          chalk.bold.yellow(`  ⚠ Public start is now ${toUtc8Time(new Date(decision.startMs))} UTC+8 — firing as soon as the chain allows.`)
        );
        targetStart = new Date(decision.startMs);
      }

      if (maxValueWei !== undefined && fresh.value > maxValueWei) {
        console.log(
          chalk.bold.red(
            `  ✗ Total ${formatEther(fresh.value)} exceeds the ${formatEther(maxValueWei)} cap — skipping this target.`
          )
        );
        return skipped();
      }

      if (fresh.data !== planNow.data || fresh.value !== planNow.value) {
        console.log(
          chalk.bold.yellow(
            `  ⚠ Drop changed: ${formatEther(planNow.drop.mintPrice)} → ${formatEther(fresh.drop.mintPrice)} per NFT, fee recipient ${planNow.feeRecipient} → ${fresh.feeRecipient}. Using the fresh values.`
          )
        );
      }

      planNow = fresh;
      break;
    }
  } else if (maxValueWei !== undefined && planNow.value > maxValueWei) {
    console.log(
      chalk.bold.red(
        `  ✗ Total ${formatEther(planNow.value)} exceeds the ${formatEther(maxValueWei)} cap — skipping this target.`
      )
    );
    return skipped();
  }

  // Re-warm after the wait: keep-alive sockets are usually torn down by the far
  // end long before T-0, and the blast must not pay for a fresh handshake.
  await warmConnections(rpcUrls);

  // ── Pre-fetch everything the signature depends on, then sign ──
  const [nonces, network] = await Promise.all([
    Promise.all(wallets.map((w) => provider.getTransactionCount(w.address, "pending"))),
    provider.getNetwork(),
  ]);
  const chainId = network.chainId;
  console.log(chalk.gray(`  Nonces: [${nonces.join(", ")}] | chainId: ${chainId}`));

  const signStart = performance.now();
  const prepared: { idx: number; address: string; blast: PreparedBlast }[] = [];

  for (let i = 0; i < wallets.length; i++) {
    const rawTx = await wallets[i].signTransaction({
      to: planNow.to,
      data: planNow.data,
      value: planNow.value,
      nonce: nonces[i],
      maxFeePerGas,
      maxPriorityFeePerGas: maxPriorityFee,
      gasLimit: gasLimit || 250_000,
      type: 2,
      chainId,
    });
    prepared.push({ idx: i, address: wallets[i].address, blast: prepareBlast(rawTx) });
  }

  console.log(
    chalk.green(
      `  ✓ Signed and serialised ${prepared.length} transaction(s) in ${(performance.now() - signStart).toFixed(1)}ms — zero compute left at fire time`
    )
  );

  // ── Wait for the stage, then blast pre-built bytes ──
  if (targetStart) {
    await waitForMintTime(targetStart, 0);
  } else {
    console.log(chalk.bold.yellow("\n  🚀 Sending now..."));
  }

  const stageStartMs = targetStart ? targetStart.getTime() : Date.now();
  const dispatchStart = performance.now();

  const fired = prepared.map(({ idx, address, blast }) => {
    const { txHash, responsePromise } = blastToAll(blast, endpoints);
    return { idx, address, txHash, responsePromise };
  });

  const dispatchMs = (performance.now() - dispatchStart).toFixed(2);
  const sinceStage = Math.max(0, Date.now() - stageStartMs);
  console.log(
    chalk.bold.green(`  SENT ${fired.length} transaction(s) (${dispatchMs}ms, +${sinceStage}ms after stage open)`)
  );
  for (const f of fired) {
    console.log(chalk.gray(`    [W${f.idx}] ${f.txHash}`));
  }

  // Dispatch only means "bytes written". Find out whether any endpoint actually
  // took the transaction before promising a receipt that may never exist.
  const settled = await Promise.all(
    fired.map(async (f) => ({ ...f, results: await f.responsePromise }))
  );

  const accepted = settled.filter(({ results }) =>
    results.some((r) => r.txHash !== null || (r.error ?? "").includes("already known"))
  );
  const rejected = settled.filter((s) => !accepted.includes(s));

  for (const { idx, results } of rejected) {
    const reasons = [...new Set(results.map((r) => r.error).filter(Boolean))];
    console.log(chalk.bold.red(`\n  ✗ [W${idx}] Rejected by every RPC — not broadcast.`));
    for (const reason of reasons) console.log(chalk.red(`      ${reason}`));
    if (reasons.some((r) => (r ?? "").includes("less than block base fee"))) {
      console.log(chalk.yellow("      → Max fee is below the chain's base fee. Raise it and rerun."));
    }
  }

  const acceptedByIdx = new Map(accepted.map((a) => [a.idx, a.txHash] as const));
  const statusByIdx = new Map<number, SnipeStatus>(
    settled.map((s) => [s.idx, acceptedByIdx.has(s.idx) ? "TIMEOUT" : "REJECTED"] as const)
  );

  const collect = (): SnipeResult[] =>
    prepared.map(({ idx, address }) => ({
      idx,
      address,
      txHash: acceptedByIdx.get(idx) ?? null,
      status: statusByIdx.get(idx) ?? "REJECTED",
    }));

  if (accepted.length === 0) {
    console.log(chalk.bold.red("\n===== NOTHING WAS BROADCAST — NO RECEIPTS TO WAIT FOR =====\n"));
    return collect();
  }

  // ── Receipts (only for txs an endpoint actually accepted) ──
  console.log(chalk.gray("\n  Waiting for receipts..."));
  await Promise.all(
    accepted.map(async ({ idx, txHash }) => {
      const receipt = await waitForReceipt(txHash, rpcUrls[0], 60_000);
      if (!receipt) {
        statusByIdx.set(idx, "TIMEOUT");
        console.log(chalk.yellow(`  [W${idx}] TIMEOUT — check: ${explorerTx(chainId, txHash)}`));
        return;
      }
      statusByIdx.set(idx, receipt.status === "SUCCESS" ? "SUCCESS" : "REVERTED");
      const color = receipt.status === "SUCCESS" ? chalk.bold.green : chalk.bold.red;
      console.log(
        color(`  [W${idx}] Block: ${receipt.block} | Pos: ${receipt.position} | ${receipt.status} | Gas: ${receipt.gasUsed}`)
      );
      console.log(chalk.gray(`  [W${idx}] Track: ${explorerTx(chainId, txHash)}`));
    })
  );

  console.log(chalk.bold.white("\n===== LOCAL PUBLIC MINT COMPLETE ====="));
  return collect();
}
