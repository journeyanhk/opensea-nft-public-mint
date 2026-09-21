// Batch mode: run several public mints in one unattended session.
//
// The runner owns everything shared across targets — keys, RPCs, gas, the
// balance check and the single interactive confirmation — then hands each target
// to the single-target executor in local-mint. Execution is serial by design: the
// next target's nonce is only fetched at its own fire time, minutes later, so no
// nonce coordination is needed between targets.
//
// With --watch the config is re-read on an interval and new targets join the
// queue; an execution ledger (`txHash` non-null means the chain was touched)
// keeps a restart from minting the same drop twice.

import fs from "fs";
import path from "path";
import chalk from "chalk";
import { JsonRpcProvider, Wallet, formatEther, formatUnits } from "ethers";
import { resolveChain } from "./chains";
import { BatchTarget, loadBatchConfig } from "./batch-config";
import { planRpcs, resolveRpcsForChain } from "./rpc-resolver";
import { localPublicSnipe, SnipeResult } from "./local-mint";
import { burstGate, calibrateLead } from "./burst";
import { acquireWalletLock, WalletLock } from "./wallet-lock";
import { acquireLanes, LaneCoordinator, orderJobs, planReservation } from "./batch-coordinator";
import { advance, createJobs, JobEvent } from "./target-job";
import { auditTarget } from "./audit/audit";
import { waitForMintTime } from "./timer";
import { toUtc8Time } from "./time-format";
import { askYesNo, closePrompts } from "./prompt";
import { walletKeysFromEnv } from "./wallet-keys";
import { promptKeys } from "./wizard";
import { RawConfig, diffKeys } from "./batch-watch";
import { fileTargetSource, TargetSource, watchTargetSource } from "./target-source";
import {
  DEFAULT_LEDGER_PATH,
  Ledger,
  emptyLedger,
  entryOf,
  loadLedger,
  recordEntry,
  saveLedger,
  shouldSkipLedger,
} from "./batch-ledger";

export interface BatchRunOptions {
  watch?: boolean;
  watchFiles?: string[];
  watchIntervalMs?: number;
  ledger?: boolean;
  retryPending?: boolean;
  ledgerPath?: string;
  maxPolls?: number; // stop polling after N cycles (tests); 0/undefined = unlimited
  dryRun?: boolean; // --dry-run forces it on; a config file may set it itself
  burst?: Partial<{ count: number; spacingMs: number; leadMs: number | "auto"; allowOvershoot: boolean; forceClock: boolean }>;
  parallel?: boolean;
  parallelLimit?: number;
  targetSource?: TargetSource; // tests and B5 inject one; default = config + watch files
  assumeYes?: boolean; // the executor is armed by hand, so it does not ask again
  shouldAbort?: () => boolean; // the queue may have been cancelled while we waited
}

function readConfig(file: string): RawConfig {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    throw new Error(`Could not read ${file}: ${(err as Error).message}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${(err as Error).message}`);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// A dry run must never touch the ledger. A stray PENDING entry reads as "this
// may already be on chain" and silently blocks the next real run.
export function shouldWriteLedger(useLedger: boolean, dryRun: boolean): boolean {
  return useLedger && !dryRun;
}

export async function runBatch(configPath: string, options: BatchRunOptions = {}): Promise<void> {
  const watch = options.watch === true;
  const watchFiles = options.watchFiles ?? [];
  const intervalMs = Math.max(1_000, options.watchIntervalMs ?? 60_000);
  const useLedger = options.ledger !== false;
  const retryPending = options.retryPending === true;
  const ledgerPath = options.ledgerPath ?? DEFAULT_LEDGER_PATH;

  // Where targets come from: the config file, plus the files --watch merges in.
  // B5 adds a queue source behind the same interface.
  const targetSource: TargetSource = options.targetSource ?? watchTargetSource(configPath, watchFiles, {
    onAppear: (file) => console.log(chalk.gray(`  ${file} appeared`)),
    onMissing: (file) => console.log(chalk.gray(`  waiting for ${file} (not created yet)`)),
  });
  const loadMerged = (): RawConfig => targetSource.read();

  let raw = loadMerged();
  const chain = resolveChain(raw?.chain);
  if (!chain) {
    throw new Error(`${configPath}: unsupported chain "${raw?.chain}". Use one of ethereum/base/robinhood/arc.`);
  }

  console.log(chalk.bold.cyan(`\nBatch mode — ${chain.name} (${chain.chainId})`));
  if (watch) {
    console.log(
      chalk.gray(
        `  watch: re-reading every ${Math.round(intervalMs / 1000)}s — ${[configPath, ...watchFiles].join(", ")}`
      )
    );
  }

  // ── 1. RPCs: config override, then .env, then public fallbacks ─────────
  const manual = Array.isArray(raw.rpcs) ? raw.rpcs.map(String) : [];
  const { urls: candidateRpcs, source } = resolveRpcsForChain(chain.key, manual);
  console.log(chalk.gray(`  RPC source: ${source}`));

  const rpcPlan = await planRpcs(candidateRpcs, chain.chainId);
  if (rpcPlan.urls.length === 0) {
    throw new Error(`No usable RPC endpoint for ${chain.name}.`);
  }
  if (!rpcPlan.verified) {
    throw new Error(`No RPC endpoint confirmed chain ID ${chain.chainId} — refusing to send unattended.`);
  }
  for (const bad of rpcPlan.dropped) {
    const wrong = resolveChain(bad.chainId);
    console.log(chalk.red(`    ✗ dropped ${bad.url} — reports chain ${bad.chainId}${wrong ? ` (${wrong.name})` : ""}`));
  }
  for (const failure of rpcPlan.failures) {
    console.log(chalk.yellow(`    ⚠ ${failure.url} — ${failure.message.slice(0, 90)}`));
  }
  console.log(chalk.green(`  ✓ ${rpcPlan.urls.length} endpoint(s), chain ID ${chain.chainId} confirmed`));
  const rpcUrls = rpcPlan.urls;

  // ── 2. Targets ────────────────────────────────────────────────────────
  console.log(chalk.bold.white("\nTargets"));
  let cfg = await loadBatchConfig(raw, chain, rpcUrls, { allowEmpty: watch });
  if (options.dryRun) cfg = { ...cfg, dryRun: true };
  if (options.burst) cfg = { ...cfg, burst: { ...cfg.burst, ...options.burst } };
  if (options.parallel) cfg = { ...cfg, parallel: true, ...(options.parallelLimit ? { parallelLimit: options.parallelLimit } : {}) };
  if (cfg.dryRun) {
    console.log(
      chalk.bold.yellow("  DRY RUN — transactions are signed and simulated, never broadcast; the ledger is untouched.")
    );
  }

  // ── 3. Wallets ────────────────────────────────────────────────────────
  console.log(chalk.bold.white("\nWallets"));
  const keys = cfg.walletSource === "env" ? walletKeysFromEnv() : await promptKeys();
  if (keys.length === 0) {
    throw new Error("No wallet keys — set PRIVATE_KEY/PRIVATE_KEYS in .env, or use \"walletSource\": \"prompt\".");
  }
  const wallets = keys.map((k) => new Wallet(k));

  const provider = new JsonRpcProvider(cfg.rpcUrls[0]);

  // A max fee under the chain's base fee is rejected by every node, which would
  // otherwise only surface as a rejected broadcast at fire time. Fail now, while
  // the config can still be fixed.
  const latestBlock = await provider.getBlock("latest").catch(() => null);
  const baseFee = latestBlock?.baseFeePerGas ?? null;
  if (baseFee !== null && cfg.maxFeePerGas < baseFee) {
    const headroom = Math.ceil((Number(formatUnits(baseFee, "gwei")) * 2 + Number(formatUnits(cfg.maxPriorityFee, "gwei"))) * 1000) / 1000;
    throw new Error(
      `Max fee ${formatUnits(cfg.maxFeePerGas, "gwei")} gwei is below ${chain.name}'s current base fee ${formatUnits(baseFee, "gwei")} gwei. ` +
        `Raise MAX_FEE_PER_GAS (or gas.maxFeeGwei in ${configPath}); around ${headroom} gwei leaves headroom.`
    );
  }

  const gasReservePerTarget = BigInt(cfg.gasLimit) * cfg.maxFeePerGas;
  // Burst spends gas on shots that are expected to revert, so affordability
  // reserves the worst case (every shot fired) up front.
  const burstShots = cfg.burst.count > 1 ? cfg.burst.count : 1;

  let burstLead: Awaited<ReturnType<typeof calibrateLead>> | null = null;
  if (cfg.burst.count > 1) {
    burstLead = await calibrateLead({ rpcUrls: cfg.rpcUrls });
    console.log(
      chalk.gray(
        `  burst: lead ${burstLead.leadMs}ms (rtt ${burstLead.rttMs}ms, clock skew ${
          burstLead.clockSkewMs === null ? "unknown" : `${burstLead.clockSkewMs}ms`
        })${burstLead.suspectClock ? " — clock looks wrong" : ""}`
      )
    );
  }
  const ledger: Ledger = useLedger ? loadLedger(ledgerPath) : emptyLedger();
  // Worst-case spend per target, accumulated per job so a watched batch that
  // merges a third target sees what the first two already committed.
  const coordinator = new LaneCoordinator();
  const reservationFor = (target: BatchTarget): bigint =>
    planReservation({
      value: target.plan.value,
      gasLimit: BigInt(cfg.gasLimit),
      maxFeePerGas: cfg.maxFeePerGas,
      shots: burstShots,
      overshoot: cfg.burst.count > 1 && cfg.burst.allowOvershoot,
    });

  // ── 4. Queue ──────────────────────────────────────────────────────────
  const queue: BatchTarget[] = [];
  const known = new Set<string>(); // contracts ever considered this run
  const executed = new Set<string>(); // dequeued and processed (audited/attempted)
  const summary: { label: string; results: SnipeResult[] }[] = [];

  const keyOf = (target: BatchTarget): string => target.contract.toLowerCase();
  const ledgerSkipped = (target: BatchTarget): boolean =>
    useLedger &&
    shouldSkipLedger(entryOf(ledger, cfg.chainKey, target.contract), {
      retryPending,
      stageOpen: target.plan.drop.endTime * 1000 > Date.now(),
    });

  const skippedAll = (): SnipeResult[] =>
    wallets.map((w, idx) => ({ idx, address: w.address, txHash: null, status: "SKIPPED" as const }));

  const affordable = async (target: BatchTarget): Promise<boolean> => {
    const required = reservationFor(target);
    for (const wallet of wallets) {
      const balance = await provider.getBalance(wallet.address).catch(() => null);
      const committed = coordinator.reservedTotal(wallet.address);
      if (balance === null || balance < committed + required) {
        if (cfg.dryRun) {
          // Rehearsing is exactly how one checks the pipeline with an empty
          // wallet; a balance problem is a warning there, not a refusal.
          console.log(
            chalk.yellow(`  ⚠ ${target.label}: ${wallet.address} cannot cover ${formatEther(required)} ${chain.nativeSymbol} — dry run continues`)
          );
          continue;
        }
        console.log(
          chalk.yellow(`  ✗ ${target.label} skipped — ${wallet.address} cannot cover ${formatEther(required)} ${chain.nativeSymbol} yet`)
        );
        return false;
      }
    }
    return true;
  };

  const enqueue = async (targets: BatchTarget[], announce: boolean, checkAffordability: boolean): Promise<number> => {
    let added = 0;
    for (const target of targets) {
      const key = keyOf(target);
      if (known.has(key)) continue;

      if (target.plan.drop.endTime * 1000 <= Date.now()) {
        known.add(key);
        if (announce) console.log(chalk.gray(`  - ${target.label} — public stage already ended`));
        continue;
      }
      if (ledgerSkipped(target)) {
        known.add(key);
        if (announce) console.log(chalk.gray(`  - ${target.label} — already handled (ledger)`));
        continue;
      }
      // A wallet that is short now may be topped up later, so an unaffordable
      // target is retried periodically instead of being forgotten.
      if (checkAffordability) {
        if (Date.now() < (affordabilityRetry.get(key) ?? 0)) continue;
        if (!(await affordable(target))) {
          affordabilityRetry.set(key, Date.now() + AFFORDABILITY_RETRY_MS);
          continue;
        }
        affordabilityRetry.delete(key);
        // The target just proved it fits; claim its worst case so a later
        // --watch merge cannot spend the same balance twice.
        for (const wallet of wallets) {
          coordinator.reserve({ jobId: key, wallet: wallet.address, wei: reservationFor(target) });
        }
      } else {
        for (const wallet of wallets) {
          coordinator.reserve({ jobId: key, wallet: wallet.address, wei: reservationFor(target) });
        }
      }

      known.add(key);
      queue.push(target);
      added++;
      if (announce) {
        console.log(chalk.cyan(`  + ${target.label}  ${toUtc8Time(target.startAt)} UTC+8  ×${target.quantity}  ${target.contract}`));
        if (target.plan.value > target.maxValueWei) {
          console.log(
            chalk.yellow(`    ⚠ price ${formatEther(target.plan.value)} is above the maxPriceEth cap — it will be skipped at T-refresh`)
          );
        }
      }
    }
    queue.sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
    return added;
  };

  // The startup balance precheck already covers every initial target.
  await enqueue(cfg.targets, false, false);

  const actionable = [...queue];
  const ledgerCount = cfg.targets.filter(ledgerSkipped).length;
  if (ledgerCount > 0) console.log(chalk.gray(`  ${ledgerCount} target(s) already handled per the ledger`));

  // ── 4b. Wallet locks: one process per wallet, for the whole run ───────
  // Nonces are a counter, so two processes sending from the same wallet would
  // collide. The lock is an OS-owned socket (a crash releases it) plus a
  // pid/token file (diagnostics + stale recovery).
  const walletLocks: WalletLock[] = [];
  if (!cfg.dryRun) {
    const lockDir = path.resolve(process.cwd(), ".locks");
    try {
      for (const wallet of wallets) {
        walletLocks.push(await acquireWalletLock(wallet.address, lockDir));
      }
      console.log(chalk.gray(`  wallet locks: ${walletLocks.length} held in ${lockDir}`));
    } catch (err) {
      for (const lock of walletLocks) await lock.release();
      throw new Error(`${(err as Error).message} — another batch or the executor may be running.`);
    }
  }

  // ── 5. Balance precheck (only for what can actually run) ──────────────
  // Every actionable target reserves its worst case with the coordinator first;
  // the check then compares each wallet's balance against the accumulated
  // reservations. --watch merges land in the same pot, so a third target is
  // refused here instead of failing at T-3s.
  for (const target of actionable) {
    const wei = reservationFor(target);
    for (const wallet of wallets) {
      coordinator.reserve({ jobId: keyOf(target), wallet: wallet.address, wei });
    }
  }
  const requiredPerWallet = wallets.reduce(
    (max, wallet) => {
      const total = coordinator.reservedTotal(wallet.address);
      return total > max ? total : max;
    },
    0n
  );

  if (actionable.length > 0) {
    const short: string[] = [];
    const balances = await Promise.all(wallets.map((w) => provider.getBalance(w.address).catch(() => null)));
    wallets.forEach((w, i) => {
      const bal = balances[i];
      const committed = coordinator.reservedTotal(w.address);
      const text = bal === null ? "balance unreadable" : `${Number(formatEther(bal)).toFixed(6)} ${chain.nativeSymbol}`;
      const insufficient = bal === null || bal < committed;
      if (insufficient) {
        const gap = bal === null ? 0n : committed - bal;
        short.push(`[W${i}] ${w.address} ${text} (committed ${formatEther(committed)}, short ${formatEther(gap)})`);
      }
      const line = `  [W${i}] ${w.address}  ${text}`;
      console.log(insufficient ? chalk.red(`${line}  ✗ needs ${formatEther(committed)}`) : chalk.gray(line));
    });

    if (short.length > 0) {
      const message =
        `Wallet(s) short of funds for ${actionable.length} actionable target(s):\n  ${short.join("\n  ")}\n` +
        `  Each wallet needs ≥ ${formatEther(requiredPerWallet)} ${chain.nativeSymbol} (mint value + gasLimit × maxFee per target).`;
      for (const target of actionable) {
        for (const wallet of wallets) coordinator.unreserve({ jobId: keyOf(target), wallet: wallet.address });
      }
      if (!cfg.dryRun) throw new Error(message);
      console.log(chalk.yellow(`  ⚠ ${message}`));
      console.log(chalk.yellow("  dry run continues — no transaction will be broadcast."));
    }
  } else {
    console.log(chalk.gray("  no actionable targets — nothing to fund"));
  }

  // ── 6. Schedule + one confirmation ────────────────────────────────────
  {
    const { conflicts } = orderJobs(
      actionable.map((target) => ({
        id: target.label,
        wallets: wallets.map((wallet) => wallet.address),
        startMs: target.startAt.getTime(),
        priority: 0,
      }))
    );
    for (const conflict of conflicts) {
      console.log(
        chalk.bold.yellow(
          `  ⚠ schedule conflict on ${conflict.wallet}: ${conflict.jobs[0]} and ${conflict.jobs[1]} start within 5s — the second will wait for the first wallet lane.`
        )
      );
    }
  }
  console.log(chalk.bold.white("\n──────── BATCH SCHEDULE ────────"));
  const scheduleTargets = cfg.targets;
  for (const t of scheduleTargets) {
    const line =
      `  ${chalk.white(toUtc8Time(t.startAt))} UTC+8  ${chalk.bold(t.label)}  ×${t.quantity}  ` +
      `${formatEther(t.plan.value)} ${chain.nativeSymbol}/wallet  cap ${formatEther(t.maxValueWei)}`;
    const remaining =
      t.supply && t.supply.maxSupply > 0n ? t.supply.maxSupply - t.supply.totalMinted : null;
    const suffix =
      remaining !== null && remaining <= 0n
        ? `  ${chalk.bold.red(`SOLD OUT (${t.supply!.totalMinted}/${t.supply!.maxSupply} minted)`)}`
        : ledgerSkipped(t)
          ? chalk.gray("  (ledger: already handled)")
          : remaining !== null
            ? chalk.gray(`  ${t.supply!.totalMinted}/${t.supply!.maxSupply} minted`)
            : "";
    console.log(line + suffix);
  }
  console.log(
    chalk.gray(
      `  wallets ${wallets.length} | refresh T-${cfg.refreshBeforeMs}ms | audit T-${Math.round(cfg.auditBeforeMs / 1000)}s | ` +
        `on failure ${cfg.onFailure} | budget ${formatEther(requiredPerWallet)} ${chain.nativeSymbol}/wallet`
    )
  );
  console.log(chalk.bold.white("────────────────────────────────"));

  if (actionable.length === 0 && !watch) {
    console.log(chalk.yellow("\n  Nothing to execute.\n"));
    closePrompts();
    return;
  }

  if (!options.assumeYes && !(await askYesNo(chalk.bold(watch ? "Watch for targets and run them unattended?" : "Run this batch unattended?"), false))) {
    console.log(chalk.yellow("\n  Cancelled — nothing was sent.\n"));
    closePrompts();
    return;
  }

  // Hand stdin back so readline never interleaves with the blast logging.
  closePrompts();

  // ── 7. Polling ────────────────────────────────────────────────────────
  const affordabilityRetry = new Map<string, number>(); // key -> next affordability check
  const AFFORDABILITY_RETRY_MS = 5 * 60_000;
  let stop = false;
  let polls = 0;
  const poll = async (): Promise<void> => {
    if (!watch) return;
    if (options.maxPolls !== undefined && options.maxPolls > 0 && ++polls > options.maxPolls) return;
    try {
      const merged = loadMerged();
      const next = await loadBatchConfig(merged, chain, rpcUrls, { quiet: true, allowEmpty: true });
      cfg = next;

      // Drop queued targets that disappeared from the config.
      const incoming = new Set(next.targets.map((t) => t.contract.toLowerCase()));
      const queued = new Set(queue.map((t) => t.contract.toLowerCase()));
      for (const key of diffKeys(queued, incoming).removed) {
        const index = queue.findIndex((t) => t.contract.toLowerCase() === key);
        if (index >= 0) {
          console.log(chalk.yellow(`  - ${queue[index].label} — removed from config`));
          queue.splice(index, 1);
        }
        // A target that left the config before running is forgotten, so a later
        // re-export (grade C rising back to B) can queue it again.
        if (!executed.has(key)) known.delete(key);
      }

      const added = await enqueue(next.targets, true, true);
      if (added > 0) console.log(chalk.bold(`  merged ${added} new target(s) into the queue`));
      if (options.maxPolls !== undefined && options.maxPolls > 0 && polls >= options.maxPolls) {
        console.log(chalk.gray(`  watch stopped after ${polls} poll(s)`));
        stop = true;
      }
    } catch (err) {
      console.log(chalk.yellow(`  config re-read failed, keeping the current queue: ${(err as Error).message}`));
    }
  };

  const waitWithPolling = async (deadlineMs: number): Promise<void> => {
    while (Date.now() < deadlineMs) {
      await sleep(Math.min(intervalMs, Math.max(1, deadlineMs - Date.now())));
      await poll();
    }
  };

  // ── 8. Execute the queue: serially by default, concurrently with --parallel ──
  // The per-target flow (audit wait, burst gate, prepare, send, receipts, ledger)
  // lives in one job function so both modes run exactly the same code.
  const executeJob = async (target: BatchTarget): Promise<void> => {
    // One job = one target; the state machine is the same one the executor will
    // drive in B5, so the log lines already speak its language.
    const job = createJobs(
      [{ id: keyOf(target), contract: target.contract, startMs: target.startAt.getTime(), wallets: wallets.map((w) => w.address) }],
      Date.now()
    )[0];
    const setState = (event: JobEvent): void => {
      if (advance(job, event)) console.log(chalk.gray(`  job ${job.id.slice(0, 12)} → ${job.state}`));
    };
    setState("prepare");

      if (target.plan.drop.endTime * 1000 <= Date.now()) {
        console.log(chalk.yellow(`\n━━━ ${target.label} — public stage already ended, skipping ━━━`));
        summary.push({ label: target.label, results: skippedAll() });
        return;
      }

      console.log(chalk.bold.magenta(`\n━━━ ${target.label} (${target.contract}) ━━━`));

      // B3: the burst decision belongs here, where the config, the per-wallet cap
      // and the measured clock are all known. A refused burst degrades to a
      // single transaction — never to a refusal to mint.
      let burstForTarget: { count: number; spacingMs: number; leadMs: number } | undefined;
      if (cfg.burst.count > 1 && burstLead) {
        const cap = target.plan.drop.maxTotalMintableByWallet || null;
        const gate = burstGate({
          count: cfg.burst.count,
          capPerWallet: cap,
          allowOvershoot: cfg.burst.allowOvershoot,
          clockSkewMs: burstLead.clockSkewMs,
          leadMs: cfg.burst.leadMs === "auto" ? burstLead.leadMs : cfg.burst.leadMs,
          forceClock: cfg.burst.forceClock,
        });
        if (!gate.allowed) {
          console.log(chalk.bold.yellow(`  ⚠ burst disabled for ${target.label}: ${gate.reason} — sending a single transaction.`));
        } else {
          const leadMs = cfg.burst.leadMs === "auto" ? burstLead.leadMs : cfg.burst.leadMs;
          burstForTarget = { count: cfg.burst.count, spacingMs: cfg.burst.spacingMs, leadMs };
          console.log(chalk.gray(`  burst: ×${cfg.burst.count} at T-${leadMs}ms, ${cfg.burst.spacingMs}ms apart (${gate.reason})`));
        }
      }

      // Re-audit shortly before the stage opens: a whitelist phase can drain the
      // supply in the meantime, and the T-3s on-chain check is the last line of
      // defence rather than the first. An audit that cannot run never blocks a mint.
      if (cfg.auditBeforeMs > 0 && target.startAt.getTime() > Date.now()) {
        const deadline = target.startAt.getTime() - cfg.auditBeforeMs;
        if (deadline > Date.now()) {
          if (watch) await waitWithPolling(deadline);
          else await waitForMintTime(new Date(deadline), 0);
        } else {
          console.log(chalk.gray("  audit window already open — checking now"));
        }
        try {
          const audit = await auditTarget(
            { chainKey: cfg.chainKey, target: target.contract },
            { wallets: wallets.map((w) => w.address), requestedQuantity: target.quantity }
          );
          console.log(chalk.gray(`  audit: ${audit.grade.grade} — ${audit.grade.reason}`));
          if (cfg.auditSkipGrades.includes(audit.grade.grade)) {
            console.log(chalk.bold.yellow(`  skipping ${target.label}: audit grade ${audit.grade.grade}`));
            const results = skippedAll();
            summary.push({ label: target.label, results });
            if (shouldWriteLedger(useLedger, cfg.dryRun)) {
              recordEntry(ledger, cfg.chainKey, target.contract, {
                status: "SKIPPED",
                txHash: null,
                at: new Date().toISOString(),
                quantity: target.quantity,
                slug: target.slug,
                attempts: entryOf(ledger, cfg.chainKey, target.contract)?.attempts ?? 0,
              });
              saveLedger(ledger, ledgerPath);
            }
            return;
          }
        } catch (err) {
          console.log(chalk.yellow(`  audit unavailable, continuing: ${(err as Error).message}`));
        }
      }

      // Once bytes may reach the chain, the ledger must already say so: a crash
      // between broadcast and receipt then blocks a duplicate send.
      const priorAttempts = entryOf(ledger, cfg.chainKey, target.contract)?.attempts ?? 0;
      const attempts = priorAttempts + 1;
      if (shouldWriteLedger(useLedger, cfg.dryRun)) {
        recordEntry(ledger, cfg.chainKey, target.contract, {
          status: "PENDING",
          txHash: null,
          at: new Date().toISOString(),
          quantity: target.quantity,
          slug: target.slug,
          attempts,
        });
        saveLedger(ledger, ledgerPath);
      }

      let results: SnipeResult[];
      try {
        results = await localPublicSnipe({
          nftContract: target.contract,
          quantity: target.quantity,
          walletKeys: keys,
          rpcUrls: cfg.rpcUrls,
          maxFeePerGas: cfg.maxFeePerGas,
          maxPriorityFee: cfg.maxPriorityFee,
          gasLimit: cfg.gasLimit,
          targetStart: target.startAt.getTime() > Date.now() ? target.startAt : null,
          plan: target.plan,
          maxValueWei: target.maxValueWei,
          refreshBeforeMs: cfg.refreshBeforeMs,
          expectedCodeHash: target.codeHash,
          dryRun: cfg.dryRun,
          burst: burstForTarget,
          // B4: preparation overlaps, the send does not. The lane is taken after
          // the gates and before the wait, so a second job sharing this wallet
          // waits here instead of signing the same nonce.
          shouldAbort: options.shouldAbort,
        beforeSend: async () => {
            const lease = await acquireLanes({
              coordinator,
              jobId: job.id,
              wallets: wallets.map((wallet) => wallet.address),
              onWait: (waiting, waitedMs) =>
                console.log(chalk.gray(`  waiting for the wallet lane (${Math.round(waitedMs)}ms): ${waiting.length} wallet(s) busy`)),
            });
            const lateMs = Date.now() - target.startAt.getTime();
            if (target.startAt.getTime() > 0 && lateMs > 0) {
              console.log(chalk.bold.yellow(`  ⚠ lane busy: firing ${Math.round(lateMs)}ms after the open`));
            }
            if (target.plan.drop.endTime * 1000 <= Date.now()) {
              lease.release();
              throw new Error("the stage ended while waiting for the wallet lane");
            }
            setState("lane");
            return () => lease.release();
          },
        });
      } catch (err) {
        console.log(chalk.bold.red(`  ✗ ${target.label} failed: ${(err as Error).message}`));
        console.log(chalk.yellow("  ledger stays PENDING — pass --retry-pending to send again"));
        summary.push({ label: target.label, results: skippedAll() });
        return;
      }

      summary.push({ label: target.label, results });

      setState("receipt");
      if (shouldWriteLedger(useLedger, cfg.dryRun)) {
      const broadcast = results.find((r) => r.txHash !== null);
        const status = broadcast
          ? broadcast.status
          : results.every((r) => r.status === "SKIPPED" || r.status === "REJECTED")
            ? "SKIPPED"
            : "REJECTED";
        const TOKEN_ID_LIMIT = 200;
        recordEntry(ledger, cfg.chainKey, target.contract, {
          status,
          txHash: broadcast?.txHash ?? null,
          at: new Date().toISOString(),
          quantity: target.quantity,
          slug: target.slug,
          attempts,
          // B1: what actually arrived, so cost basis and net stop being fiction.
          ...(broadcast?.mintedCount !== undefined ? { mintedCount: broadcast.mintedCount } : {}),
          ...(broadcast?.tokenIds && broadcast.tokenIds.length > 0
            ? {
                tokenIds: broadcast.tokenIds.slice(0, TOKEN_ID_LIMIT),
                ...(broadcast.tokenIds.length > TOKEN_ID_LIMIT ? { tokenIdsTruncated: true } : {}),
              }
            : {}),
          ...(broadcast?.gasBurnedWei ? { gasBurnedWei: broadcast.gasBurnedWei } : {}),
          ...(broadcast?.txHashes && broadcast.txHashes.length > 1 ? { txHashes: broadcast.txHashes } : {}),
          ...(broadcast?.nonceGap ? { nonceGap: true } : {}),
        });
        saveLedger(ledger, ledgerPath);
      }

      if (!results.some((r) => r.status === "SUCCESS")) setState("fail");
      else setState("done");
      if (cfg.onFailure === "stop" && !results.some((r) => r.status === "SUCCESS")) {
        console.log(chalk.bold.yellow(`\n  onFailure=stop — no success on ${target.label}, ending the batch here.`));
        stop = true;
      }
  };

  const pending = new Set<Promise<void>>();
  const parallelLimit = cfg.parallel ? Math.max(1, cfg.parallelLimit ?? wallets.length) : 1;
  if (cfg.parallel) {
    console.log(
      chalk.gray(
        `  parallel: up to ${parallelLimit} job(s) preparing at once; sends serialise per wallet (${wallets.length} shared wallet(s))`
      )
    );
  }
  while (!stop || pending.size > 0) {
    if (queue.length === 0) {
      if (pending.size > 0) {
        await Promise.all([...pending]);
        continue;
      }
      if (!watch) break;
      await sleep(intervalMs);
      await poll();
      continue;
    }

    const target = queue.shift()!;
    executed.add(keyOf(target));

    if (!cfg.parallel) {
      await executeJob(target);
      continue;
    }
    // Lanes serialise a wallet anyway, so more jobs than wallets only wastes
    // memory; a finished job frees its slot here.
    if (pending.size >= parallelLimit) await Promise.race(pending);
    const job = executeJob(target).finally(() => pending.delete(job));
    pending.add(job);
  }
  await Promise.all([...pending]);

  for (const lock of walletLocks) await lock.release();

  // ── 9. Summary ────────────────────────────────────────────────────────
  console.log(chalk.bold.white("\n════════ BATCH SUMMARY ════════"));
  for (const { label, results } of summary) {
    for (const r of results) {
      const color =
        r.status === "SUCCESS"
          ? chalk.green
          : r.status === "SKIPPED" || r.status === "TIMEOUT"
            ? chalk.yellow
            : chalk.red;
      console.log(color(`  ${label}  [W${r.idx}]  ${r.status}  ${r.txHash ?? ""}`));
    }
  }
  console.log(chalk.bold.white("═══════════════════════════════\n"));
}
