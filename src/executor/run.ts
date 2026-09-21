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
import { DEFAULT_LEDGER_PATH, LedgerEntry, entryOf, loadLedger } from "../batch-ledger";
import { runBatch, BatchRunOptions } from "../batch-runner";
import { RawConfig } from "../batch-watch";
import { auditTarget } from "../audit/audit";
import { TargetSource } from "../target-source";
import {
  QueueJob,
  claimNext,
  clearArmed,
  completeJob,
  createArmToken,
  failJob,
  isArmed,
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
export function jobToRawConfig(job: QueueJob): RawConfig {
  return {
    chain: job.chain,
    targets: [
      {
        slug: job.contract,
        contract: job.contract,
        quantity: job.quantity,
        maxPriceEth: job.maxPriceEth,
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
  onProgress?: (message: string) => void;
}

export async function runExecutor(options: ExecutorOptions = {}): Promise<void> {
  assertExecutorKeys();
  const queueDir = options.queueDir ?? path.resolve(process.cwd(), "queue");
  const ledgerPath = options.ledgerPath ?? DEFAULT_LEDGER_PATH;
  const intervalMs = Math.max(500, options.intervalMs ?? 5_000);
  const host = options.host ?? os.hostname();
  const say = options.onProgress ?? ((message: string) => console.log(message));

  const token = createArmToken();
  publishArmToken(queueDir, token);
  console.log(chalk.bold.cyan(`\nExecutor — queue ${queueDir}`));
  console.log(chalk.bold.yellow(`  arm token: ${token}`));
  console.log(chalk.gray("  enter it in the panel's queue tab; it expires 12h after arming. Keep it out of logs you share."));

  if (options.dryRun) {
    // A rehearsal must not consume a job: peek at what would be claimed.
    const peek = nextEligible(queueDir, { nowMs: Date.now() });
    if (!peek) {
      console.log(chalk.gray("  dry run: no eligible job in the queue"));
    } else {
      console.log(chalk.gray(`  dry run: would claim ${peek.id}`));
      console.log(chalk.gray(`  dry run: target ${peek.chain}/${peek.contract} ×${peek.quantity} startAt ${peek.startAtMs ? new Date(peek.startAtMs).toISOString() : "auto"}`));
      console.log(chalk.gray(`  dry run: codeHash ${peek.codeHash ?? "(none pinned — gate 1 would be skipped, pin it)"}`));
    }
    clearArmed(queueDir); // a rehearsal never leaves an armed queue behind
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

    const claim = claimNext(queueDir, { by: host, nowMs: Date.now(), leaseMs: 15 * 60_000 });
    if (!claim.ok) {
      if (options.once) return;
      await sleep(intervalMs);
      continue;
    }

    const job = claim.job;
    say(chalk.bold.magenta(`\n  claimed ${job.id} — ${job.chain}/${job.contract} ×${job.quantity}`));

    if (needsAudit(job, Date.now())) {
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
        say(chalk.red(`  pre-execution audit failed: ${(err as Error).message}`));
      }
      if (!job.codeHash) {
        const failed = failJob(queueDir, job, "no codeHash could be pinned — refusing to run gate 1 blind");
        say(chalk.red(`  ${failed.status}: ${failed.error}`));
        if (options.once) return;
        continue;
      }
    }

    try {
      const batchOptions: BatchRunOptions = {
        targetSource: jobSource(job),
        watch: false,
        maxPolls: 0,
        assumeYes: true,
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
    } catch (err) {
      const failed = failJob(queueDir, job, (err as Error).message);
      say(chalk.red(`  ${failed.status}: ${failed.error}`));
    }

    if (options.once) return;
  }
}
