// The executor: the only process that holds private keys and spends money.
//
// It is the mirror image of --serve. Serve loads .env.serve and refuses to run
// with key material; the executor requires key material and owns the queue. A
// job can be enqueued by anyone with the panel password, but nothing runs until
// a human takes the arm token this process prints at startup and enters it in
// the panel — and that arm expires after twelve hours.
//
// The queue is drained one job at a time. Each job is handed to the ordinary
// batch pipeline with a TargetSource that yields exactly that job, so the three
// gates, burst rules, the ledger and the receipt counting are the same code the
// CLI uses.

import fs from "fs";
import os from "os";
import chalk from "chalk";
import path from "path";
import { formatEther } from "ethers";
import { DEFAULT_LEDGER_PATH, LedgerEntry, entryOf, loadLedger } from "../batch-ledger";
import { runBatch, BatchRunOptions } from "../batch-runner";
import { RawConfig } from "../batch-watch";
import { auditTarget } from "../audit/audit";
import { Contract, JsonRpcProvider, getAddress } from "ethers";
import { resolveChain } from "../chains";
import { maskRpc, planRpcs, resolveScanRpcs } from "../rpc-resolver";
import { createNotifier } from "../notify";
import { buildLocalMintPlan } from "../seadrop-public";
import { codeHashOf } from "../gates";
import { TargetSource } from "../target-source";
import {
  QueueJob,
  claimNext,
  clearArmed,
  completeJob,
  failJob,
  isArmed,
  findJob,
  loadOrCreateArmToken,
  nextEligible,
  publishArmToken,
  reclaimStale,
  updateJob,
} from "./queue";

export function assertExecutorKeys(env: NodeJS.ProcessEnv = process.env): void {
  const keys = [(env.PRIVATE_KEY ?? "").trim(), (env.PRIVATE_KEYS ?? "").trim()].filter(Boolean);
  if (keys.length === 0) {
    throw new Error(
      "--executor refuses to run without PRIVATE_KEY/PRIVATE_KEYS — start it with a .env.executor that holds them."
    );
  }
}

// One queue job becomes one batch target. The contract is authoritative for the
// loader (slug may be stale), and the audit snapshot travels with it so gate 1
// has something to compare and a stale snapshot can be refreshed before use.
export function jobToRawConfig(job: QueueJob, env: NodeJS.ProcessEnv = process.env): RawConfig {
  const burstCount = Number(env.BURST_COUNT ?? "1");
  return {
    chain: job.chain,
    ...(Number.isFinite(burstCount) && burstCount > 1
      ? { burst: { count: burstCount, allowOvershoot: env.BURST_ALLOW_OVERSHOOT === "1" } }
      : {}),
    targets: [
      {
        slug: job.contract,
        contract: job.contract,
        quantity: job.quantity,
        maxPriceEth: job.maxPriceEth,
        ...(job.riskFlags.length > 0 ? { riskFlags: job.riskFlags } : {}),
        startAt: job.startAtMs ? new Date(job.startAtMs).toISOString() : "auto",
        ...(job.codeHash ? { codeHash: job.codeHash } : {}),
      },
    ],
  } as RawConfig;
}

// The ledger is the single source of truth for "did this touch the chain". The
// queue result is derived from it, never invented by the executor.
export function resultFromLedgerEntry(
  entry: LedgerEntry | undefined,
  at: string
): QueueJob["result"] {
  if (!entry) return null;
  return {
    status: entry.status,
    txHash: entry.txHash,
    mintedCount: entry.mintedCount ?? null,
    ...(entry.tokenIds ? { tokenIds: entry.tokenIds } : {}),
    ...(entry.gasBurnedWei ? { gasBurnedWei: entry.gasBurnedWei } : {}),
    ledgerStatus: entry.status,
    at,
  };
}

// An automated path must never run gate 1 blind: without a pinned code hash the
// executor audits first and refuses the job if the audit cannot pin one. A
// snapshot older than the same window the CLI re-audits in is refreshed too.
export function needsAudit(job: QueueJob, nowMs: number, maxAgeMs = 30 * 60_000): boolean {
  if (!job.codeHash || !job.auditedAt) return true;
  const at = Date.parse(job.auditedAt);
  return !Number.isFinite(at) || nowMs - at > maxAgeMs;
}

// "current" is what the panel writes (and what --export means by it), but the
// loader needs a number: parseEther("current") throws. Resolve it against the
// audit snapshot and write the answer back, so the queue shows the ceiling that
// was accepted — and a price change before the open is refused by the T-refresh
// guard instead of being followed.
export function resolveMaxPriceEth(
  job: QueueJob,
  priceWei: bigint | null | undefined
): { maxPriceEth: string; resolved: boolean } {
  if (job.maxPriceEth !== "current") return { maxPriceEth: job.maxPriceEth, resolved: false };
  if (priceWei === null || priceWei === undefined) return { maxPriceEth: "current", resolved: false };
  const text = formatEther(priceWei);
  return { maxPriceEth: text === "0.0" ? "0" : text, resolved: true };
}

export interface ChainSnapshot {
  codeHash: string | null;
  mintPriceWei: string | null;
  capPerWallet: number | null;
  feeRecipient: string | null;
  name: string | null;
  rpcUrl: string;
}

// The audit is richer (grade, concentration, socials) but it also reaches
// further: an OpenSea hiccup or one HTML error page from a public RPC must not
// make gate 1 unpinnable, because the code hash only needs getCode. This is the
// minimum an automated execution needs to be safe.
export async function chainOnlySnapshot(chainKey: string, contract: string, quantity: number): Promise<ChainSnapshot> {
  const chain = resolveChain(chainKey);
  if (!chain) throw new Error(`unsupported chain "${chainKey}"`);
  const { urls } = resolveScanRpcs(chainKey);
  const plan = await planRpcs(urls, chain.chainId);
  const rpcUrl = plan.urls[0];
  if (!rpcUrl) throw new Error("no usable RPC endpoint confirmed for this chain");

  const provider = new JsonRpcProvider(rpcUrl);
  const codeHash = codeHashOf(await provider.getCode(contract));
  const mintPlan = await buildLocalMintPlan(rpcUrl, contract, quantity);
  if (!mintPlan) throw new Error("no SeaDrop public drop found on-chain");

  let name: string | null = null;
  try {
    const token = new Contract(getAddress(contract.toLowerCase()), ["function name() view returns (string)"], provider);
    name = ((await token.name().catch(() => null)) as string | null) ?? null;
  } catch {
    // a name is a nicety, not a requirement
  }

  return {
    codeHash,
    mintPriceWei: mintPlan.drop.mintPrice.toString(),
    capPerWallet: mintPlan.drop.maxTotalMintableByWallet || null,
    feeRecipient: mintPlan.feeRecipient,
    name,
    rpcUrl,
  };
}

export function jobSource(job: QueueJob): TargetSource {
  return {
    name: `queue/${job.id}`,
    watchPaths: () => [],
    read: () => jobToRawConfig(job),
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface ExecutorOptions {
  queueDir?: string;
  ledgerPath?: string;
  intervalMs?: number;
  once?: boolean;
  dryRun?: boolean;
  host?: string;
  rotateArmToken?: boolean;
  onProgress?: (message: string) => void;
}

export async function runExecutor(options: ExecutorOptions = {}): Promise<void> {
  assertExecutorKeys();
  const queueDir = options.queueDir ?? path.resolve(process.cwd(), "queue");
  const ledgerPath = options.ledgerPath ?? DEFAULT_LEDGER_PATH;
  const intervalMs = Math.max(500, options.intervalMs ?? 5_000);
  const host = options.host ?? os.hostname();
  const say = options.onProgress ?? ((message: string) => console.log(message));
  const notifier = createNotifier();

  const { token, created } = loadOrCreateArmToken(queueDir, { rotate: options.rotateArmToken === true });
  const published = publishArmToken(queueDir, token);
  console.log(chalk.bold.cyan(`\nExecutor — queue ${queueDir}`));
  console.log(chalk.bold.yellow(`  arm token: ${token}${created ? " (new)" : " (unchanged)"}`));
  console.log(
    chalk.gray(
      `  stored in queue/arm-token (0600); enter it in the panel once — it survives restarts. ` +
        `Arming itself expires (${process.env.EXECUTOR_ARM_TTL_H ?? 12}h); --rotate-arm-token replaces the token.`
    )
  );
  if (published.keptArm) {
    const state = isArmed(queueDir, Date.now());
    if (state.armed) console.log(chalk.gray(`  still armed until ${new Date(state.expiresAtMs!).toISOString()}`));
  }

  if (options.dryRun) {
    // A rehearsal must not consume a job: peek at what would be claimed.
    const peek = nextEligible(queueDir, { nowMs: Date.now() });
    if (!peek) {
      console.log(chalk.gray("  dry run: no eligible job in the queue"));
    } else {
      console.log(chalk.gray(`  dry run: would claim ${peek.id}`));
      console.log(chalk.gray(`  dry run: target ${peek.chain}/${peek.contract} ×${peek.quantity} startAt ${peek.startAtMs ? new Date(peek.startAtMs).toISOString() : "auto"}`));
      console.log(chalk.gray(`  dry run: codeHash ${peek.codeHash ?? "(none pinned — gate 1 would be skipped, pin it)"}`));
      console.log(chalk.gray(`  dry run: it would run only if the queue is armed (${isArmed(queueDir, Date.now()).armed ? "armed now" : "currently disarmed"})`));
    }
    return;
  }

  const heartbeat = (): void => {
    try {
      fs.writeFileSync(
        path.join(queueDir, "_heartbeat.json"),
        JSON.stringify({ at: new Date().toISOString(), host, pid: process.pid })
      );
    } catch {
      // a heartbeat is a convenience, never a reason to stop
    }
  };

  for (;;) {
    heartbeat();
    for (const id of reclaimStale(queueDir, { nowMs: Date.now(), maxAttempts: 2 })) {
      say(`  reclaimed ${id} (lease expired)`);
    }

    const armed = isArmed(queueDir, Date.now());
    if (!armed.armed) {
      say(chalk.gray("  not armed — enter the arm token in the panel to let jobs run"));
      if (options.once) return;
      await sleep(intervalMs);
      continue;
    }

    // 45 minutes is the longest the executor should sit on a job before the
    // send window: it matches the runner's own pre-open audit window.
    const claim = claimNext(queueDir, { by: host, nowMs: Date.now(), leaseMs: 30 * 60_000, claimWindowMs: 45 * 60_000 });
    if (!claim.ok) {
      if (options.once) return;
      await sleep(intervalMs);
      continue;
    }

    const job = claim.job;
    say(chalk.bold.magenta(`\n  claimed ${job.id} — ${job.chain}/${job.contract} ×${job.quantity}`));

    // The ledger is the single source of truth: a contract this process already
    // touched must not be executed again just because a new job was enqueued.
    const prior = entryOf(loadLedger(ledgerPath), job.chain, job.contract);
    const terminal = ["SUCCESS", "TIMEOUT", "PARTIAL", "NO_MINT"];
    if (prior && terminal.includes(prior.status)) {
      const skipped = completeJob(
        queueDir,
        job,
        { status: "SKIPPED", txHash: prior.txHash, mintedCount: prior.mintedCount ?? null, ledgerStatus: prior.status, at: new Date().toISOString() },
        Date.now()
      );
      say(chalk.yellow(`  ${skipped.status}: already handled per ledger (${prior.status})`));
      if (options.once) return;
      continue;
    }

    const wantsPrice = job.maxPriceEth === "current";
    if (needsAudit(job, Date.now()) || (wantsPrice && !job.mintPriceWei)) {
      say("  snapshot missing or stale — auditing before signing");
      try {
        const audit = await auditTarget({ chainKey: job.chain, target: job.contract }, { requestedQuantity: job.quantity });
        const snapshot = {
          codeHash: audit.codeHash,
          auditedAt: new Date().toISOString(),
          grade: audit.grade.grade,
          mintPriceWei: audit.publicDrop?.mintPrice?.toString() ?? null,
          capPerWallet: audit.publicDrop?.maxTotalMintableByWallet ?? null,
        };
        Object.assign(job, snapshot);
        updateJob(queueDir, job.id, snapshot);
        say(chalk.gray(`  snapshot: grade ${snapshot.grade} · codeHash ${snapshot.codeHash?.slice(0, 12) ?? "unavailable"}`));
      } catch (err) {
        say(chalk.yellow(`  audit unavailable (${(err as Error).message}) — falling back to chain-only reads`));
        try {
          const chainSnapshot = await chainOnlySnapshot(job.chain, job.contract, job.quantity);
          const snapshot = {
            codeHash: chainSnapshot.codeHash,
            auditedAt: new Date().toISOString(),
            mintPriceWei: chainSnapshot.mintPriceWei,
            capPerWallet: chainSnapshot.capPerWallet,
          };
          Object.assign(job, snapshot);
          updateJob(queueDir, job.id, snapshot);
          say(
            chalk.gray(
              `  chain snapshot via ${maskRpc(chainSnapshot.rpcUrl)}: codeHash ${chainSnapshot.codeHash?.slice(0, 12) ?? "unavailable"} · fee recipient ${chainSnapshot.feeRecipient ?? "?"}`
            )
          );
        } catch (fallbackErr) {
          say(chalk.red(`  chain-only reads also failed: ${(fallbackErr as Error).message}`));
          job.error = `audit failed: ${(err as Error).message}; chain reads failed: ${(fallbackErr as Error).message}`;
        }
      }
      if (!job.codeHash) {
        const failed = failJob(queueDir, job, job.error ?? "no codeHash could be pinned — refusing to run gate 1 blind");
        say(chalk.red(`  ${failed.status}: ${failed.error}`));
        if (options.once) return;
        continue;
      }
    }

    if (job.maxPriceEth === "current") {
      const resolved = resolveMaxPriceEth(job, job.mintPriceWei ? BigInt(job.mintPriceWei) : null);
      if (!resolved.resolved) {
        const failed = failJob(queueDir, job, "cannot resolve the current price to a ceiling — refusing to mint without one");
        say(chalk.red(`  ${failed.status}: ${failed.error}`));
        if (options.once) return;
        continue;
      }
      job.maxPriceEth = resolved.maxPriceEth;
      updateJob(queueDir, job.id, { maxPriceEth: resolved.maxPriceEth });
      say(chalk.gray(`  price ceiling resolved: ${resolved.maxPriceEth} ${job.chain === "robinhood" ? "native" : "ETH"} per NFT`));
    }

    // A batch can run for an hour: keep the heartbeat and the lease alive while
    // it does, so the panel does not report the executor dead and a reclaim
    // cannot hand the job to somebody else mid-flight.
    const keepAlive = setInterval(() => {
      heartbeat();
      const current = findJob(queueDir, job.id);
      if (current) updateJob(queueDir, job.id, { lease: { by: host, expiresAtMs: Date.now() + 30 * 60_000 } });
    }, 30_000);
    (keepAlive as NodeJS.Timeout).unref?.();

    try {
      const batchOptions: BatchRunOptions = {
        targetSource: jobSource(job),
        watch: false,
        maxPolls: 0,
        assumeYes: true,
        // Checked in local-mint after the fresh plan is read and before signing.
        shouldAbort: () => findJob(queueDir, job.id)?.cancelRequested === true,
      };
      await runBatch(path.join(queueDir, `${job.id}.json`), batchOptions);
      const entry = entryOf(loadLedger(ledgerPath), job.chain, job.contract);
      const result = resultFromLedgerEntry(entry, new Date().toISOString());
      const finished = completeJob(queueDir, job, result, Date.now());
      say(
        result
          ? chalk.green(`  ${finished.status}: ledger says ${result.ledgerStatus}${result.mintedCount !== null ? ` (minted ${result.mintedCount})` : ""}`)
          : chalk.yellow(`  ${finished.status}: the ledger has no entry (was anything broadcast?)`)
      );
      notifier.send({
        kind: "job-finished",
        title: `${result?.ledgerStatus ?? finished.status} — ${job.name ?? job.slug ?? job.contract}`,
        detail: [
          `minted ${result?.mintedCount ?? 0}/${job.quantity}`,
          result?.txHash ? `https://robinhoodchain.blockscout.com/tx/${result.txHash}` : null,
          `chain ${job.chain}`,
        ]
          .filter(Boolean)
          .join(" · "),
      });
    } catch (err) {
      const cancelled = findJob(queueDir, job.id)?.cancelRequested === true;
      const finished = cancelled
        ? completeJob(queueDir, job, { status: "SKIPPED", txHash: null, mintedCount: null, ledgerStatus: "CANCELLED", at: new Date().toISOString() }, Date.now())
        : failJob(queueDir, job, (err as Error).message);
      say(chalk.red(`  ${finished.status}: ${cancelled ? "cancelled before signing" : finished.error}`));
      notifier.send({
        kind: "job-finished",
        title: `${finished.status} — ${job.name ?? job.slug ?? job.contract}`,
        detail: cancelled ? "cancelled before signing" : String(finished.error ?? "").slice(0, 300),
      });
    } finally {
      clearInterval(keepAlive);
    }

    if (options.once) return;
  }
}
