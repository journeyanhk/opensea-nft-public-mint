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
import { buildLocalMintPlan, fetchMintStats, LocalMintPlan, MintStats } from "./seadrop-public";
import { countMintedTokens, verdict } from "./receipts";
import { classifySimulation, codeHashOf, validateMintPublicCalldata, validateSignedTx } from "./gates";

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
  }

  // ── Gate 3: a pending simulation per wallet (gate 2 runs on the signature) ─
  const stageOpen = targetStart ? Date.now() >= targetStart.getTime() : true;
  const dropped: number[] = [];
  for (const { idx, wallet } of active) {
    try {
      await provider.send("eth_call", [
        { from: wallet.address, to: planNow.to, data: planNow.data, value: `0x${planNow.value.toString(16)}` },
        "pending",
      ]);
      console.log(chalk.gray(`  ✓ [W${idx}] Gate 3: simulation passed`));
    } catch (err) {
      const anyErr = err as { shortMessage?: string; info?: { error?: { message?: string } }; message?: string };
      const text = anyErr.shortMessage ?? anyErr.info?.error?.message ?? anyErr.message ?? "";
      const outcome = classifySimulation({ ok: false, errorText: text, stageOpen });
      if (outcome.pass) {
        console.log(chalk.gray(`  · [W${idx}] Gate 3: ${outcome.label}`));
      } else {
        dropped.push(idx);
        console.log(chalk.bold.red(`  ✗ [W${idx}] Gate 3: ${outcome.label} — dropping this wallet.`));
      }
    }
  }
  if (dropped.length > 0) {
    active = active.filter(({ idx }) => !dropped.includes(idx));
    if (active.length === 0) {
      console.log(chalk.bold.red("  ✗ Every wallet failed the simulation — skipping this target."));
      return skipped();
    }
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
  const gateErrors: string[] = [];

  for (const [i, { idx, wallet }] of active.entries()) {
    const rawTx = await wallet.signTransaction({
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

    // ── Gate 2: what was signed must be exactly what was planned ────────────
    const signed = validateSignedTx(rawTx, {
      from: wallet.address,
      chainId,
      to: planNow.to,
      nonce: nonces[i],
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
        gateErrors.push(`[W${idx}] ${error}`);
      }
      continue;
    }
    prepared.push({ idx, address: wallet.address, blast: prepareBlast(rawTx) });
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

  if (opts.dryRun) {
    console.log(chalk.bold.yellow("\n  DRY RUN — signed and simulated, nothing broadcast."));
    for (const p of prepared) console.log(chalk.gray(`    [W${p.idx}] would send ${p.blast.txHash}`));
    return skipped();
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

  console.log(chalk.bold.white("\n===== LOCAL PUBLIC MINT COMPLETE ====="));
  return finish();
}
