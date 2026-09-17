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
import chalk from "chalk";
import { JsonRpcProvider, Wallet, formatEther, formatUnits } from "ethers";
import { resolveChain } from "./chains";
import { BatchTarget, loadBatchConfig } from "./batch-config";
import { planRpcs, resolveRpcsForChain } from "./rpc-resolver";
import { localPublicSnipe, SnipeResult } from "./local-mint";
import { auditTarget } from "./audit/audit";
import { waitForMintTime } from "./timer";
import { toUtc8Time } from "./time-format";
import { askYesNo, closePrompts } from "./prompt";
import { walletKeysFromEnv } from "./wallet-keys";
import { promptKeys } from "./wizard";
import { RawConfig, diffKeys, mergeRawConfigs } from "./batch-watch";
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

export async function runBatch(configPath: string, options: BatchRunOptions = {}): Promise<void> {
  const watch = options.watch === true;
  const watchFiles = options.watchFiles ?? [];
  const intervalMs = Math.max(1_000, options.watchIntervalMs ?? 60_000);
  const useLedger = options.ledger !== false;
  const retryPending = options.retryPending === true;
  const ledgerPath = options.ledgerPath ?? DEFAULT_LEDGER_PATH;

  const loadMerged = (): RawConfig => mergeRawConfigs(readConfig(configPath), watchFiles.map(readConfig));

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
  let cfg = await loadBatchConfig(raw, chain, rpcUrls);

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
  const ledger: Ledger = useLedger ? loadLedger(ledgerPath) : emptyLedger();

  // ── 4. Queue ──────────────────────────────────────────────────────────
  const queue: BatchTarget[] = [];
  const known = new Set<string>(); // contracts ever considered this run
  const done = new Set<string>(); // executed, ended, or ledger-skipped
  const summary: { label: string; results: SnipeResult[] }[] = [];

  const keyOf = (target: BatchTarget): string => target.contract.toLowerCase();
  const ledgerSkipped = (target: BatchTarget): boolean =>
    useLedger && shouldSkipLedger(entryOf(ledger, cfg.chainKey, target.contract), { retryPending });

  const skippedAll = (): SnipeResult[] =>
    wallets.map((w, idx) => ({ idx, address: w.address, txHash: null, status: "SKIPPED" as const }));

  const affordable = async (target: BatchTarget): Promise<boolean> => {
    const required = target.plan.value + gasReservePerTarget;
    for (const wallet of wallets) {
      const balance = await provider.getBalance(wallet.address).catch(() => null);
      if (balance === null || balance < required) {
        console.log(
          chalk.yellow(`  ✗ ${target.label} skipped — ${wallet.address} cannot cover ${formatEther(required)} ${chain.nativeSymbol} yet`)
        );
        return false;
      }
    }
    return true;
  };

  const enqueue = (targets: BatchTarget[], announce: boolean): number => {
    let added = 0;
    for (const target of targets) {
      const key = keyOf(target);
      if (known.has(key)) continue;
      known.add(key);

      if (target.plan.drop.endTime * 1000 <= Date.now()) {
        done.add(key);
        if (announce) console.log(chalk.gray(`  - ${target.label} — public stage already ended`));
        continue;
      }
      if (ledgerSkipped(target)) {
        done.add(key);
        if (announce) console.log(chalk.gray(`  - ${target.label} — already handled (ledger)`));
        continue;
      }

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

  enqueue(cfg.targets, false);

  const actionable = queue.filter((target) => !done.has(keyOf(target)));
  const ledgerCount = cfg.targets.filter(ledgerSkipped).length;
  if (ledgerCount > 0) console.log(chalk.gray(`  ${ledgerCount} target(s) already handled per the ledger`));

  // ── 5. Balance precheck (only for what can actually run) ──────────────
  const requiredPerWallet = actionable.reduce((sum, t) => sum + t.plan.value + gasReservePerTarget, 0n);

  if (actionable.length > 0) {
    const short: string[] = [];
    const balances = await Promise.all(wallets.map((w) => provider.getBalance(w.address).catch(() => null)));
    wallets.forEach((w, i) => {
      const bal = balances[i];
      const text = bal === null ? "balance unreadable" : `${Number(formatEther(bal)).toFixed(6)} ${chain.nativeSymbol}`;
      const insufficient = bal === null || bal < requiredPerWallet;
      if (insufficient) short.push(`[W${i}] ${w.address} ${text}`);
      const line = `  [W${i}] ${w.address}  ${text}`;
      console.log(insufficient ? chalk.red(`${line}  ✗ needs ${formatEther(requiredPerWallet)}`) : chalk.gray(line));
    });

    if (short.length > 0) {
      throw new Error(
        `Wallet(s) short of funds for ${actionable.length} actionable target(s):\n  ${short.join("\n  ")}\n` +
          `  Each wallet needs ≥ ${formatEther(requiredPerWallet)} ${chain.nativeSymbol} (mint value + gasLimit × maxFee per target).`
      );
    }
  } else {
    console.log(chalk.gray("  no actionable targets — nothing to fund"));
  }

  // ── 6. Schedule + one confirmation ────────────────────────────────────
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

  if (!(await askYesNo(chalk.bold(watch ? "Run this batch unattended and watch for new targets?" : "Run this batch unattended?"), false))) {
    console.log(chalk.yellow("\n  Cancelled — nothing was sent.\n"));
    closePrompts();
    return;
  }

  // Hand stdin back so readline never interleaves with the blast logging.
  closePrompts();

  // ── 7. Polling ────────────────────────────────────────────────────────
  let stop = false;
  let polls = 0;
  const poll = async (): Promise<void> => {
    if (!watch) return;
    if (options.maxPolls !== undefined && options.maxPolls > 0 && ++polls > options.maxPolls) return;
    try {
      const merged = loadMerged();
      const next = await loadBatchConfig(merged, chain, rpcUrls, { quiet: true });
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
      }

      for (const target of next.targets) {
        if (known.has(keyOf(target))) continue;
        if (!(await affordable(target))) {
          known.add(keyOf(target));
          done.add(keyOf(target));
          continue;
        }
      }
      const added = enqueue(next.targets, true);
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

  // ── 8. Execute the queue in start-time order ──────────────────────────
  while (!stop) {
    if (queue.length === 0) {
      if (!watch) break;
      await sleep(intervalMs);
      await poll();
      continue;
    }

    const target = queue.shift()!;
    const key = keyOf(target);
    done.add(key);

    if (target.plan.drop.endTime * 1000 <= Date.now()) {
      console.log(chalk.yellow(`\n━━━ ${target.label} — public stage already ended, skipping ━━━`));
      summary.push({ label: target.label, results: skippedAll() });
      continue;
    }

    console.log(chalk.bold.magenta(`\n━━━ ${target.label} (${target.contract}) ━━━`));

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
          if (useLedger) {
            recordEntry(ledger, cfg.chainKey, target.contract, {
              status: "SKIPPED",
              txHash: null,
              at: new Date().toISOString(),
              quantity: target.quantity,
              slug: target.slug,
            });
            saveLedger(ledger, ledgerPath);
          }
          continue;
        }
      } catch (err) {
        console.log(chalk.yellow(`  audit unavailable, continuing: ${(err as Error).message}`));
      }
    }

    // Once bytes may reach the chain, the ledger must already say so: a crash
    // between broadcast and receipt then blocks a duplicate send.
    if (useLedger) {
      recordEntry(ledger, cfg.chainKey, target.contract, {
        status: "PENDING",
        txHash: null,
        at: new Date().toISOString(),
        quantity: target.quantity,
        slug: target.slug,
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
      });
    } catch (err) {
      console.log(chalk.bold.red(`  ✗ ${target.label} failed: ${(err as Error).message}`));
      console.log(chalk.yellow("  ledger stays PENDING — pass --retry-pending to send again"));
      summary.push({ label: target.label, results: skippedAll() });
      continue;
    }

    summary.push({ label: target.label, results });

    if (useLedger) {
      const broadcast = results.find((r) => r.txHash !== null);
      const status = broadcast
        ? broadcast.status
        : results.every((r) => r.status === "SKIPPED" || r.status === "REJECTED")
          ? "SKIPPED"
          : "REJECTED";
      recordEntry(ledger, cfg.chainKey, target.contract, {
        status,
        txHash: broadcast?.txHash ?? null,
        at: new Date().toISOString(),
        quantity: target.quantity,
        slug: target.slug,
      });
      saveLedger(ledger, ledgerPath);
    }

    if (cfg.onFailure === "stop" && !results.some((r) => r.status === "SUCCESS")) {
      console.log(chalk.bold.yellow(`\n  onFailure=stop — no success on ${target.label}, ending the batch here.`));
      stop = true;
    }
  }

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
