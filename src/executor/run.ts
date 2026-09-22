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
import { Contract, JsonRpcProvider, Wallet, getAddress } from "ethers";
import { resolveChain } from "../chains";
import { maskRpc, planRpcs, resolveScanRpcs } from "../rpc-resolver";
import { createNotifier } from "../notify";
import { walletKeysFromEnv } from "../wallet-keys";
import { buildLocalMintPlan } from "../seadrop-public";
import { codeHashOf } from "../gates";
import { TargetSource } from "../target-source";
import {
  QueueJob,
  claimMany,
  clearArmed,
  completeJob,
  failJob,
  isArmed,
  findJob,
  loadOrCreateArmToken,
  nextEligible,
  publishArmToken,
  reclaimStale,
  setArmed,
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

// The audit already answers the question the executor cares about most: is
// there a SeaDrop public drop here at all? A target that fails that test must be
// rejected with that reason, not with a gate-1 message about a missing hash.
export function applicabilityError(audit: {
  applicable: boolean;
  notApplicableReason?: string;
}): string | null {
  return audit.applicable ? null : audit.notApplicableReason ?? "not applicable (no SeaDrop public drop)";
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
  const code = await provider.getCode(contract);
  const codeHash = codeHashOf(code);
  if (codeHash === null) {
    throw new Error(`no contract code at ${contract} on ${chainKey} (wrong chain or address?)`);
  }
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


// One runBatch per chain, with every claimed job of that chain as a target:
// preparation overlaps and the wallet lanes serialise the sends, which is what
// the coordinator was built for. Same-wallet jobs no longer wait for each other
// to finish, only to send.
export function mergeJobConfigs(jobs: QueueJob[]): RawConfig {
  const chain = jobs[0].chain;
  const targets = jobs.flatMap((job) => jobToRawConfig(job).targets ?? []);
  return { chain, parallel: true, targets } as RawConfig;
}

// A cancel must only stop its own job: the runner asks per target, so map the
// target back to the job that produced it.
export function abortFor(
  queueDir: string,
  jobs: QueueJob[],
  target: { chain: string; contract: string }
): boolean {
  const job = jobs.find(
    (candidate) => candidate.chain === target.chain && candidate.contract.toLowerCase() === target.contract.toLowerCase()
  );
  return job ? findJob(queueDir, job.id)?.cancelRequested === true : false;
}

export function startKeepAlive(
  queueDir: string,
  jobs: QueueJob[],
  host: string,
  heartbeat: () => void,
  intervalMs = 30_000
): () => void {
  const timer = setInterval(() => {
    heartbeat();
    for (const job of jobs) {
      if (!findJob(queueDir, job.id)) continue;
      updateJob(queueDir, job.id, { lease: { by: host, expiresAtMs: Date.now() + 30 * 60_000 } });
    }
  }, intervalMs);
  (timer as NodeJS.Timeout).unref?.();
  return () => clearInterval(timer);
}

export interface ExecutorOptions {
  queueDir?: string;
  ledgerPath?: string;
  intervalMs?: number;
  once?: boolean;
  dryRun?: boolean;
  host?: string;
  rotateArmToken?: boolean;
  claimBatch?: number; // jobs claimed per cycle (default CLAIM_BATCH or 8)
  walletChain?: string; // which chain's RPC to read balances from (default robinhood)
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

  // The token may be pinned in .env.executor (ARM_TOKEN=...) instead of the
  // generated file; either way only its hash is stored in the queue.
  const envToken = (process.env.ARM_TOKEN ?? "").trim();
  const { token, created } = envToken
    ? { token: envToken, created: false }
    : loadOrCreateArmToken(queueDir, { rotate: options.rotateArmToken === true });
  const published = publishArmToken(queueDir, token);
  const armHours = Number(process.env.EXECUTOR_ARM_TTL_H ?? "12");
  const armForever = Number.isFinite(armHours) && armHours === 0;
  const autoArm = process.env.AUTO_ARM === "1" || process.env.EXECUTOR_ALWAYS_ARMED === "1";

  console.log(chalk.bold.cyan(`\nExecutor — queue ${queueDir}`));
  console.log(
    chalk.bold.yellow(
      `  arm token: ${envToken ? "from ARM_TOKEN in .env.executor" : `${token}${created ? " (new)" : " (unchanged)"}`}`
    )
  );
  console.log(
    chalk.gray(
      envToken
        ? `  pin it in .env.executor (ARM_TOKEN=); change it there and restart to rotate. ` +
            `Arming ${armForever ? "never expires" : `expires after ${armHours}h`}.`
        : `  stored in queue/arm-token (0600); enter it in the panel once — it survives restarts. ` +
            `Arming ${armForever ? "never expires" : `expires after ${armHours}h`}; --rotate-arm-token replaces the token.`
    )
  );

  if (autoArm) {
    const armed = setArmed(queueDir, { token, nowMs: Date.now() });
    console.log(
      armed.ok
        ? chalk.green(`  auto-armed (AUTO_ARM=1)${armForever ? " — stays armed until disarmed" : ""}`)
        : chalk.red(`  auto-arm failed: ${armed.reason}`)
    );
  } else if (published.keptArm) {
    const state = isArmed(queueDir, Date.now());
    if (state.armed) {
      console.log(
        chalk.gray(
          state.expiresAtMs === Number.MAX_SAFE_INTEGER
            ? "  still armed (no expiry)"
            : `  still armed until ${new Date(state.expiresAtMs!).toISOString()}`
        )
      );
    }
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

  // The panel has no keys and no RPC of its own, so the executor publishes what
  // it can see about its wallets: balance and nonce, refreshed with the
  // heartbeat. Reservations live inside a batch's coordinator and are not
  // published (the queue summary covers "how many jobs are about to fire").
  let walletCache: { address: string; balanceWei: string; nonce: number }[] = [];
  const refreshWallets = async (): Promise<void> => {
    try {
      const keys = walletKeysFromEnv();
      if (keys.length === 0) return;
      const addresses = keys.map((key) => new Wallet(key).address);
      const chain = options.walletChain ?? "robinhood";
      const { urls } = resolveScanRpcs(chain);
      const plan = await planRpcs(urls, resolveChain(chain)?.chainId ?? 0);
      const rpc = plan.urls[0];
      if (!rpc) return;
      const provider = new JsonRpcProvider(rpc);
      walletCache = await Promise.all(
        addresses.map(async (address) => {
          try {
            const [balance, nonce] = await Promise.all([
              provider.getBalance(address),
              provider.getTransactionCount(address, "pending"),
            ]);
            return { address, balanceWei: balance.toString(), nonce };
          } catch {
            return { address, balanceWei: "0", nonce: -1 };
          }
        })
      );
    } catch {
      // the wallet view is a convenience; a heartbeat without it still counts
    }
  };

  const heartbeat = (): void => {
    try {
      fs.writeFileSync(
        path.join(queueDir, "_heartbeat.json"),
        JSON.stringify({ at: new Date().toISOString(), host, pid: process.pid, wallets: walletCache })
      );
    } catch {
      // a heartbeat is a convenience, never a reason to stop
    }
  };

  await refreshWallets();
  const walletRefresh = setInterval(() => {
    void refreshWallets();
  }, 30_000);
  (walletRefresh as NodeJS.Timeout).unref?.();

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

    // Claim a whole window at once: jobs inside the same 45 minutes prepare
    // together and their sends are serialised per wallet by the lanes, instead
    // of the second job waiting for the first one to finish entirely.
    const configuredBatch = Number(process.env.CLAIM_BATCH);
    const batchLimit = Math.max(1, Math.floor(options.claimBatch ?? (Number.isFinite(configuredBatch) && configuredBatch > 0 ? configuredBatch : 8)));
    const claimed = claimMany(queueDir, {
      by: host,
      nowMs: Date.now(),
      leaseMs: 30 * 60_000,
      claimWindowMs: 45 * 60_000,
      limit: batchLimit,
    });
    if (claimed.length === 0) {
      if (options.once) return;
      await sleep(intervalMs);
      continue;
    }

    const ready: QueueJob[] = [];
    for (const job of claimed) {
      say(chalk.bold.magenta(`\n  claimed ${job.id} — ${job.chain}/${job.contract} ×${job.quantity}`));

      // The ledger is the single source of truth: a contract this process
      // already touched must not be executed again for a new job.
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
        continue;
      }

      const wantsPrice = job.maxPriceEth === "current";
      if (needsAudit(job, Date.now()) || (wantsPrice && !job.mintPriceWei)) {
        say("  snapshot missing or stale — auditing before signing");
        try {
          const audit = await auditTarget({ chainKey: job.chain, target: job.contract }, { requestedQuantity: job.quantity });
          const notApplicable = applicabilityError(audit);
          if (notApplicable) {
            const failed = failJob(queueDir, job, notApplicable);
            say(chalk.red(`  ${failed.status}: ${failed.error} — nothing to mint here (chain ${job.chain})`));
            notifier.send({ kind: "job-finished", title: `${failed.status} — ${job.name ?? job.slug ?? job.contract}`, detail: notApplicable });
            continue;
          }
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
          continue;
        }
      }

      if (wantsPrice) {
        const resolved = resolveMaxPriceEth(job, job.mintPriceWei ? BigInt(job.mintPriceWei) : null);
        if (!resolved.resolved) {
          const failed = failJob(queueDir, job, "cannot resolve the current price to a ceiling — refusing to mint without one");
          say(chalk.red(`  ${failed.status}: ${failed.error}`));
          continue;
        }
        job.maxPriceEth = resolved.maxPriceEth;
        updateJob(queueDir, job.id, { maxPriceEth: resolved.maxPriceEth });
        say(chalk.gray(`  price ceiling resolved: ${resolved.maxPriceEth}`));
      }

      ready.push(job);
    }

    if (ready.length === 0) {
      if (options.once) return;
      continue;
    }

    // One batch per chain (the loader takes a single chain per config); chains
    // run one after another, jobs within a chain in parallel.
    const byChain = new Map<string, QueueJob[]>();
    for (const job of ready) {
      const group = byChain.get(job.chain) ?? [];
      group.push(job);
      byChain.set(job.chain, group);
    }

    for (const [chain, jobs] of byChain) {
      say(chalk.bold.cyan(`\n  running ${jobs.length} job(s) on ${chain} — parallel, lanes serialise per wallet`));
      const stopKeepAlive = startKeepAlive(queueDir, jobs, host, heartbeat);
      try {
        await runBatch(path.join(queueDir, `${jobs[0].id}.json`), {
          targetSource: { name: `queue/${chain}`, watchPaths: () => [], read: () => mergeJobConfigs(jobs) },
          watch: false,
          maxPolls: 0,
          assumeYes: true,
          shouldAbort: (target) => abortFor(queueDir, jobs, { chain, contract: target.contract }),
        });
        for (const job of jobs) {
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
        }
      } catch (err) {
        for (const job of jobs) {
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
        }
      } finally {
        stopKeepAlive();
      }
    }

    if (options.once) return;
  }
}
