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
import { blastToAll, parseRpcEndpoints, prepareBlast, waitForReceipt, BlastResult, PreparedBlast } from "./rpc-blast";
import { warmConnections } from "./connection-warmer";
import { waitForMintTime } from "./timer";
import { explorerTx } from "./chains";
import { toUtc8Time } from "./time-format";
import { buildLocalMintPlan, fetchMintStats, LocalMintPlan, MintStats } from "./seadrop-public";
import { countMintedTokens, verdict } from "./receipts";
import { aggregateBurst, gapFillerTx, planBurst } from "./burst";
import { freeQuantityFor } from "./quantity";
import { classifySimulation, codeHashOf, revertDataOf, validateMintPublicCalldata, validateSignedTx } from "./gates";

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
  expectedCodeHash?: string | null; // B2 gate 1: the code hash the audit saw
  dryRun?: boolean; // sign and simulate, never broadcast
  // B3: consecutive nonces fired just before the open (the gate that decides
  // whether a burst is allowed runs in the caller, which knows the config).
  burst?: { count: number; spacingMs: number; leadMs: number };
  freeMaxQuantity?: number; // 0 disables the free-drop quantity policy
  // B4: acquire the wallet lane here — after signing and the gates, before the
  // send. Preparing does not hold the lane, sending does; the returned function
  // releases it.
  beforeSend?: () => Promise<() => void>;
  // A queue job can be cancelled while it waits; the last moment to notice is
  // after the fresh plan is read and before anything is signed.
  shouldAbort?: () => boolean;
}

// SUCCESS means the receipt proved the tokens arrived (M8/B1); PARTIAL and
// NO_MINT are what a status==1 receipt can also mean.
export type SnipeStatus = "SUCCESS" | "PARTIAL" | "NO_MINT" | "REVERTED" | "TIMEOUT" | "REJECTED" | "SKIPPED";

export interface SnipeResult {
  idx: number;
  address: string;
  txHash: string | null;
  status: SnipeStatus;
  mintedCount?: number;
  tokenIds?: string[];
  gasBurnedWei?: string;
  txHashes?: string[]; // every shot of a burst, for the ledger
  nonceGap?: boolean; // a burst left a hole in the nonce sequence
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

// A public stage can be an empty shell: a whitelist phase often mints the whole
// supply before it opens. `maxSupply === 0n` means the contract does not pin a
// supply, so no verdict can be given and the mint is attempted as before.
export function supplyVerdict(
  totalMinted: bigint,
  maxSupply: bigint,
  requested: bigint
): "sold-out" | "tight" | "ok" {
  if (maxSupply <= 0n) return "ok";
  const remaining = maxSupply - totalMinted;
  if (remaining <= 0n) return "sold-out";
  if (remaining < requested) return "tight";
  return "ok";
}

// `cap` 0 means unlimited in SeaDrop terms. The count is cumulative, so a wallet
// that minted in a whitelist phase is already part-way to its public cap.
export function exceedsWalletCap(minted: bigint, quantity: number, cap: number): boolean {
  return cap > 0 && minted + BigInt(quantity) > BigInt(cap);
}

export async function localPublicSnipe(opts: LocalSnipeOpts): Promise<SnipeResult[]> {
  let quantity = opts.quantity;
  const {
    nftContract, walletKeys, rpcUrls,
    maxFeePerGas, maxPriorityFee, gasLimit, plan, maxValueWei,
  } = opts;

  const refreshMs = opts.refreshBeforeMs ?? 0;
  // Free drops take the per-wallet cap (bounded by freeMaxQuantity); paid drops
  // take one. Decided from the fresh plan at T-refresh, see quantity.ts.
  const freeMaxQuantity = Math.max(0, Math.floor(opts.freeMaxQuantity ?? 0));
  const burst = opts.burst && opts.burst.count > 1 ? opts.burst : null;
  let targetStart = opts.targetStart;
  let planNow = plan;

  const provider = new JsonRpcProvider(rpcUrls[0]);
  const endpoints = parseRpcEndpoints(rpcUrls);
  const wallets = walletKeys.map((k) => new Wallet(k, provider));

  const skipped = (): SnipeResult[] =>
    wallets.map((w, i) => ({ idx: i, address: w.address, txHash: null, status: "SKIPPED" as const }));

  // Wallets can be dropped before signing (already at their on-chain cap), so the
  // send path works on this list while results still cover every wallet.
  let active = wallets.map((wallet, idx) => ({ idx, wallet }));

  // A public stage can already be empty: a whitelist phase often mints the whole
  // supply before it opens, leaving the public stage as a shell. Read supply and
  // per-wallet counts while the decision is still free. Returns false when there
  // is nothing left to mint.
  async function checkSupply(cap: number): Promise<boolean> {
    const stats = await Promise.all(
      wallets.map((w) => fetchMintStats(provider, nftContract, w.address))
    );
    const headline = stats.find((s): s is MintStats => s !== null);
    if (!headline) return true; // the contract cannot answer; never block the mint over it

    active = active.filter(({ idx, wallet }) => {
      const s = stats[idx];
      if (!s || !exceedsWalletCap(s.mintedByWallet, quantity, cap)) return true;
      console.log(
        chalk.bold.red(
          `  ✗ [W${idx}] ${wallet.address} already minted ${s.mintedByWallet} of cap ${cap} — dropping it.`
        )
      );
      return false;
    });
    if (active.length === 0) {
      console.log(chalk.bold.red("  ✗ Every wallet is at its on-chain cap — skipping this target."));
      return false;
    }

    const requested = BigInt(quantity * active.length);
    const verdict = supplyVerdict(headline.totalMinted, headline.maxSupply, requested);
    if (verdict === "sold-out") {
      console.log(
        chalk.bold.red(
          `  ✗ Sold out on-chain: ${headline.totalMinted}/${headline.maxSupply} minted — skipping this target.`
        )
      );
      return false;
    }
    if (verdict === "tight") {
      console.log(
        chalk.bold.yellow(
          `  ⚠ Only ${headline.maxSupply - headline.totalMinted} left on-chain for ${requested} requested — expect partial failure.`
        )
      );
    }
    return true;
  }

  // The quantity can change here, so the calldata (which encodes it) is rebuilt
  // from the same fresh plan: one extra read at T-refresh, no stale calldata.
  const applyQuantityPolicy = async (plan: LocalMintPlan): Promise<LocalMintPlan> => {
    if (freeMaxQuantity === 0) return plan;
    const policy = freeQuantityFor({
      mintPriceWei: plan.drop.mintPrice,
      capPerWallet: plan.drop.maxTotalMintableByWallet,
      freeMaxQuantity,
    });
    if (policy.quantity === quantity) return plan;
    console.log(chalk.bold.gray(`  quantity policy: ${policy.reason} (was ${quantity})`));
    quantity = policy.quantity;
    return (await buildLocalMintPlan(rpcUrls[0], nftContract, quantity)) ?? plan;
  };

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

      let fresh = await buildLocalMintPlan(rpcUrls[0], nftContract, quantity);
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

      fresh = await applyQuantityPolicy(fresh);

      if (maxValueWei !== undefined && fresh.value > maxValueWei) {
        console.log(
          chalk.bold.red(
            `  ✗ Total ${formatEther(fresh.value)} exceeds the ${formatEther(maxValueWei)} cap — skipping this target.`
          )
        );
        return skipped();
      }

      // A public stage can already be empty: a whitelist phase often mints the
      // whole supply before it opens, leaving the public stage as a shell.
      if (!(await checkSupply(fresh.drop.maxTotalMintableByWallet))) return skipped();

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
  } else {
    planNow = await applyQuantityPolicy(planNow);

    if (maxValueWei !== undefined && planNow.value > maxValueWei) {
      console.log(
        chalk.bold.red(
          `  ✗ Total ${formatEther(planNow.value)} exceeds the ${formatEther(maxValueWei)} cap — skipping this target.`
        )
      );
      return skipped();
    }
    // No refresh window (wizard path): the plan is read once up front, but a
    // sold-out stage is still worth refusing before anything is signed.
    if (!(await checkSupply(planNow.drop.maxTotalMintableByWallet))) return skipped();
  }

  // ── Gate 1: the contract must still be the one the audit saw ─────────────
  if (opts.expectedCodeHash) {
    const actual = codeHashOf(await provider.getCode(nftContract));
    if (actual !== opts.expectedCodeHash) {
      console.log(
        chalk.bold.red(
          `  ✗ Contract code changed since the audit (${actual ?? "no code at this address"} vs ${opts.expectedCodeHash}) — refusing to sign.`
        )
      );
      return skipped();
    }
    console.log(chalk.gray(`  ✓ Gate 1: contract code hash matches the audit (${actual.slice(0, 12)}…)`));
  } else {
    // Silence here reads as "the gate passed"; it did not run at all.
    console.log(
      chalk.yellow(
        "  · Gate 1 skipped: no codeHash pinned in the target — add the audit's code hash to enable the contract-identity check."
      )
    );
  }

  // ── Gate 3: a pending simulation per wallet (gate 2 runs on the signature) ─
  // Before the stage opens SeaDrop can only answer NotActive, so simulating
  // would learn nothing while eating the T-0 budget; those seconds are what the
  // arrival time depends on. Once open, every wallet simulates in parallel.
  const stageOpen = targetStart ? Date.now() >= targetStart.getTime() : true;
  if (!stageOpen) {
    console.log(chalk.gray("  · Gate 3 skipped: the stage is not open yet (a pre-open call only returns NotActive)."));
  } else {
    const outcomes = await Promise.all(
      active.map(async ({ idx, wallet }) => {
        try {
          await provider.send("eth_call", [
            { from: wallet.address, to: planNow.to, data: planNow.data, value: `0x${planNow.value.toString(16)}` },
            "pending",
          ]);
          return { idx, pass: true, label: "simulation passed" };
        } catch (err) {
          const anyErr = err as { shortMessage?: string; info?: { error?: { message?: string } }; message?: string };
          const text = anyErr.shortMessage ?? anyErr.info?.error?.message ?? anyErr.message ?? "";
          const outcome = classifySimulation({ ok: false, errorText: text, revertData: revertDataOf(err), stageOpen: true });
          return { idx, pass: outcome.pass, label: outcome.label };
        }
      })
    );
    for (const outcome of outcomes) {
      if (outcome.pass) console.log(chalk.gray(`  ✓ [W${outcome.idx}] Gate 3: ${outcome.label}`));
      else console.log(chalk.bold.red(`  ✗ [W${outcome.idx}] Gate 3: ${outcome.label} — dropping this wallet.`));
    }
    const dropped = outcomes.filter((outcome) => !outcome.pass).map((outcome) => outcome.idx);
    if (dropped.length > 0) {
      active = active.filter(({ idx }) => !dropped.includes(idx));
      if (active.length === 0) {
        console.log(chalk.bold.red("  ✗ Every wallet failed the simulation — skipping this target."));
        return skipped();
      }
    }
  }

  if (opts.shouldAbort?.()) {
    console.log(chalk.bold.yellow("  ⚠ Cancelled while waiting (queue flag) — nothing will be signed."));
    return skipped();
  }

  // Re-warm after the wait: keep-alive sockets are usually torn down by the far
  // end long before T-0, and the blast must not pay for a fresh handshake.
  await warmConnections(rpcUrls);

  // ── Pre-fetch everything the signature depends on, then sign ──
  const [nonces, network] = await Promise.all([
    Promise.all(active.map(({ wallet }) => provider.getTransactionCount(wallet.address, "pending"))),
    provider.getNetwork(),
  ]);
  const chainId = network.chainId;
  console.log(chalk.gray(`  Nonces: [${nonces.join(", ")}] | chainId: ${chainId}`));

  const signStart = performance.now();
  const prepared: { idx: number; address: string; blast: PreparedBlast }[] = [];
  const burstShots = new Map<number, PreparedBlast[]>();
  const gateErrors: string[] = [];

  // Signs every shot for one wallet from a given base nonce and re-proves the
  // result with gate 2. Called once before the lane is held and again afterwards
  // if another job spent a nonce in the meantime.
  const signShots = async (
    wallet: Wallet,
    idx: number,
    baseNonce: number
  ): Promise<PreparedBlast[] | null> => {
    const shotNonces = burst ? planBurst(baseNonce, burst.count) : [baseNonce];
    const walletsShots: PreparedBlast[] = [];

    for (const [shotIndex, shotNonce] of shotNonces.entries()) {
      const rawTx = await wallet.signTransaction({
        to: planNow.to,
        data: planNow.data,
        value: planNow.value,
        nonce: shotNonce,
        maxFeePerGas,
        maxPriorityFeePerGas: maxPriorityFee,
        gasLimit: gasLimit || 250_000,
        type: 2,
        chainId,
      });

      // ── Gate 2: what was signed must be exactly what was planned ──────────
      const signed = validateSignedTx(rawTx, {
        from: wallet.address,
        chainId,
        to: planNow.to,
        nonce: shotNonce,
        data: planNow.data,
        value: planNow.value,
        gasLimit: BigInt(gasLimit || 250_000),
        maxFeePerGas,
        maxPriorityFeePerGas: maxPriorityFee,
      });
      const calldata = validateMintPublicCalldata(planNow.data, {
        nftContract,
        feeRecipient: planNow.feeRecipient,
        quantity: BigInt(quantity),
      });
      if (!signed.ok || !calldata.ok) {
        for (const error of [...signed.errors, ...calldata.errors]) {
          gateErrors.push(`[W${idx}] shot ${shotIndex + 1}: ${error}`);
        }
        continue;
      }
      walletsShots.push(prepareBlast(rawTx));
    }

    if (walletsShots.length === 0) return null;
    return walletsShots;
  };

  for (const [i, { idx, wallet }] of active.entries()) {
    const walletsShots = await signShots(wallet, idx, nonces[i]);
    if (!walletsShots) continue;
    prepared.push({ idx, address: wallet.address, blast: walletsShots[0] });
    if (burst && burst.count > 1) burstShots.set(idx, walletsShots);
  }

  if (gateErrors.length > 0) {
    console.log(chalk.bold.red("\n  ✗ Gate 2 failed — refusing to broadcast anything."));
    for (const error of gateErrors) console.log(chalk.red(`      ${error}`));
    return skipped();
  }
  console.log(chalk.gray(`  ✓ Gate 2: ${prepared.length} signed transaction(s) re-validated field by field`));

  console.log(
    chalk.green(
      `  ✓ Signed and serialised ${prepared.length} transaction(s) in ${(performance.now() - signStart).toFixed(1)}ms — zero compute left at fire time`
    )
  );

  let releaseLane: (() => void) | null = null;
  try {
    releaseLane = (await opts.beforeSend?.()) ?? null;
  } catch (err) {
    console.log(chalk.bold.red(`  ✗ Could not take the wallet lane: ${(err as Error).message}`));
    return skipped();
  }

  // The lane is ours now, so no other job can be spending from these wallets.
  // Re-read the pending nonce: the one read before the lane may have been spent
  // while we waited, and signing the same nonce twice is what a parallel run
  // must never do.
  if (opts.beforeSend) {
    const freshNonces = await Promise.all(
      active.map(({ wallet }) => provider.getTransactionCount(wallet.address, "pending"))
    );
    for (const [i, { idx, wallet }] of active.entries()) {
      if (freshNonces[i] === nonces[i]) continue;
      console.log(
        chalk.bold.yellow(`  ⚠ [W${idx}] nonce moved ${nonces[i]} → ${freshNonces[i]} while waiting for the lane — re-signing.`)
      );
      const shots = await signShots(wallet, idx, freshNonces[i]);
      nonces[i] = freshNonces[i];
      if (!shots) continue;
      const slot = prepared.find((entry) => entry.idx === idx);
      if (slot) slot.blast = shots[0];
      if (burst && burst.count > 1) burstShots.set(idx, shots);
    }
    if (gateErrors.length > 0) {
      releaseLane?.();
      console.log(chalk.bold.red("\n  ✗ Gate 2 failed after re-signing — refusing to broadcast anything."));
      for (const error of gateErrors) console.log(chalk.red(`      ${error}`));
      return skipped();
    }
  }

  if (opts.dryRun) {
    releaseLane?.();
    console.log(chalk.bold.yellow("\n  DRY RUN — signed and simulated, nothing broadcast."));
    for (const p of prepared) {
      const shots = burstShots.get(p.idx);
      if (shots && shots.length > 1) {
        console.log(chalk.gray(`    [W${p.idx}] would send a burst of ${shots.length}:`));
        for (const shot of shots) console.log(chalk.gray(`         ${shot.txHash}`));
      } else {
        console.log(chalk.gray(`    [W${p.idx}] would send ${p.blast.txHash}`));
      }
    }
    return skipped();
  }

  // ── Burst: several nonces, the first shot just before the stage opens ─────
  if (burst && burst.count > 1 && burstShots.size > 0) {
    const stageStartMs = targetStart ? targetStart.getTime() : Date.now();
    if (targetStart) {
      console.log(
        chalk.bold.yellow(
          `\n  🔥 BURST ×${burst.count}: first shot ${burst.leadMs}ms before the open, ${burst.spacingMs}ms apart`
        )
      );
      await waitForMintTime(targetStart, burst.leadMs);
    } else {
      console.log(chalk.bold.yellow(`\n  🚀 BURST ×${burst.count} sending now...`));
    }

    const waves: { idx: number; address: string; shots: { txHash: string; responsePromise: Promise<BlastResult[]> }[] }[] =
      active.map(({ idx, wallet }) => ({ idx, address: wallet.address, shots: [] }));

    for (let shot = 0; shot < burst.count; shot++) {
      if (shot > 0) await new Promise((resolve) => setTimeout(resolve, burst.spacingMs));
      const sinceStage = Math.max(0, Date.now() - stageStartMs);
      for (const wave of waves) {
        const blast = burstShots.get(wave.idx)?.[shot];
        if (!blast) continue;
        const { txHash, responsePromise } = blastToAll(blast, endpoints);
        wave.shots.push({ txHash, responsePromise });
      }
      console.log(chalk.gray(`  shot ${shot + 1}/${burst.count} fired at +${sinceStage}ms after stage open`));
    }

    console.log(chalk.gray("\n  Waiting for burst receipts..."));
    const burstResults: SnipeResult[] = wallets.map((w, idx) => ({
      idx,
      address: w.address,
      txHash: null,
      status: "SKIPPED" as const,
    }));
    await Promise.all(
      waves.map(async (wave) => {
        const responses = await Promise.all(wave.shots.map((shot) => shot.responsePromise));
        const accepted = wave.shots.filter((_, i) =>
          responses[i].some((r) => r.txHash !== null || (r.error ?? "").includes("already known"))
        );
        const shots: Parameters<typeof aggregateBurst>[0] = [];
        for (const shot of accepted) {
          const receipt = await waitForReceipt(shot.txHash, rpcUrls[0], 60_000);
          if (!receipt) {
            shots.push({ txHash: shot.txHash, status: "TIMEOUT", mintedCount: 0 });
            continue;
          }
          const counted = countMintedTokens(receipt, { nftContract, wallet: wave.address });
          const outcome = counted.logsAvailable
            ? verdict(receipt.status, counted.count, quantity)
            : receipt.status === "SUCCESS"
              ? "MINTED"
              : "REVERTED";
          shots.push({
            txHash: shot.txHash,
            status: outcome === "MINTED" ? "SUCCESS" : outcome,
            mintedCount: counted.count,
            tokenIds: counted.tokenIds,
            gasBurnedWei: (BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPriceWei || "0")).toString(),
          });
        }
        const aggregate = aggregateBurst(shots);
        const result = burstResults[wave.idx];
        result.status = aggregate.status as SnipeStatus;
        result.txHash = aggregate.txHash ?? accepted[0]?.txHash ?? null;
        result.mintedCount = aggregate.mintedCount;
        result.tokenIds = aggregate.tokenIds;
        result.gasBurnedWei = aggregate.gasBurnedWei;
        result.txHashes = aggregate.txHashes;
        // A hole in the nonce sequence: the lowest shot never produced a
        // receipt while a later one did. Reverts spend the nonce, so this can
        // only come from a transport-level rejection — and it will stall the
        // next target that reads a pending nonce. Say it loudly.
        const lowest = accepted[0];
        const lowestSettled = lowest ? shots.some((shot) => shot.txHash === lowest.txHash && shot.status !== "TIMEOUT") : true;
        if (accepted.length > 1 && !lowestSettled) {
          // Fill the hole now: the next target that reads a pending nonce from
          // this wallet would otherwise stall behind it.
          const index = active.findIndex((entry) => entry.idx === wave.idx);
          const missingNonce = nonces[index];
          const wallet = wallets[wave.idx];
          let filled = false;
          try {
            const filler = await wallet.signTransaction(
              gapFillerTx({
                wallet: wave.address,
                nonce: missingNonce,
                gasLimit: gasLimit || 250_000,
                maxFeePerGas,
                maxPriorityFeePerGas: maxPriorityFee,
                chainId,
              })
            );
            const { txHash: fillerHash, responsePromise } = blastToAll(filler, endpoints);
            const responses = await responsePromise;
            const seen = responses.some((r) => r.txHash !== null || (r.error ?? "").includes("already known"));
            if (seen) {
              const fillerReceipt = await waitForReceipt(fillerHash, rpcUrls[0], 45_000);
              filled = fillerReceipt?.status === "SUCCESS";
              console.log(
                filled
                  ? chalk.gray(`  ✓ [W${wave.idx}] nonce gap filled with a 0-value self-transfer (${fillerHash})`)
                  : chalk.bold.yellow(`  ⚠ [W${wave.idx}] gap filler ${fillerHash} did not confirm — replace nonce ${missingNonce} manually before the next run.`)
              );
            }
          } catch (err) {
            console.log(chalk.bold.yellow(`  ⚠ [W${wave.idx}] gap filler failed: ${(err as Error).message}`));
          }
          if (!filled) {
            result.nonceGap = true;
            console.log(
              chalk.bold.yellow(
                `  ⚠ [W${wave.idx}] nonce gap: ${lowest?.txHash} (lowest nonce) has no receipt while a later shot landed — replace that nonce before the next run or it may stall.`
              )
            );
          }
        }
        const color = aggregate.mintedCount > 0 ? chalk.bold.green : chalk.bold.red;
        console.log(
          color(
            `  [W${wave.idx}] burst ×${wave.shots.length}: ${aggregate.status} | minted ${aggregate.mintedCount}/${quantity} | gas burned ${aggregate.gasBurnedWei}`
          )
        );
      })
    );
    releaseLane?.();
    console.log(chalk.bold.white("\n===== LOCAL PUBLIC MINT COMPLETE ====="));
    return burstResults;
  }

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
  const mintedByIdx = new Map<number, { count: number; tokenIds: string[]; gasBurnedWei: string }>();

  // One result per wallet: wallets dropped before signing stay SKIPPED.
  const results: SnipeResult[] = wallets.map((w, idx) => ({
    idx,
    address: w.address,
    txHash: null,
    status: "SKIPPED" as const,
  }));
  const finish = (): SnipeResult[] => {
    for (const { idx } of prepared) {
      results[idx].txHash = acceptedByIdx.get(idx) ?? null;
      results[idx].status = statusByIdx.get(idx) ?? "REJECTED";
      const minted = mintedByIdx.get(idx);
      if (minted) {
        results[idx].mintedCount = minted.count;
        results[idx].tokenIds = minted.tokenIds;
        results[idx].gasBurnedWei = minted.gasBurnedWei;
      }
    }
    return results;
  };

  if (accepted.length === 0) {
    console.log(chalk.bold.red("\n===== NOTHING WAS BROADCAST — NO RECEIPTS TO WAIT FOR =====\n"));
    return finish();
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
      // A non-reverted receipt can still have minted nothing (a race the clone
      // contracts win) or fewer tokens than requested. Count what arrived.
      const counted = countMintedTokens(receipt, { nftContract, wallet: results[idx].address });
      const outcome = counted.logsAvailable
        ? verdict(receipt.status, counted.count, quantity)
        : receipt.status === "SUCCESS"
          ? "MINTED"
          : "REVERTED"; // no log data: fall back to the old status-only reading
      const status: SnipeStatus = outcome === "MINTED" ? "SUCCESS" : outcome;
      statusByIdx.set(idx, status);
      if (counted.logsAvailable) {
        const gasBurnedWei = (BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPriceWei || "0")).toString();
        mintedByIdx.set(idx, { count: counted.count, tokenIds: counted.tokenIds, gasBurnedWei });
      }
      const color = status === "SUCCESS" ? chalk.bold.green : status === "PARTIAL" ? chalk.bold.yellow : chalk.bold.red;
      console.log(
        color(
          `  [W${idx}] Block: ${receipt.block} | Pos: ${receipt.position} | ${status} | minted ${counted.logsAvailable ? counted.count : "?"}/${quantity} | Gas: ${receipt.gasUsed}`
        )
      );
      console.log(chalk.gray(`  [W${idx}] Track: ${explorerTx(chainId, txHash)}`));
    })
  );

  releaseLane?.();
  console.log(chalk.bold.white("\n===== LOCAL PUBLIC MINT COMPLETE ====="));
  return finish();
}
