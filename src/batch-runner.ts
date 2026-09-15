// Batch mode: run several public mints in one unattended session.
//
// The runner owns everything shared across targets — keys, RPCs, gas, the
// balance check and the single interactive confirmation — then hands each target
// to the single-target executor in local-mint. Execution is serial by design: the
// next target's nonce is only fetched at its own fire time, minutes later, so no
// nonce coordination is needed between targets.

import fs from "fs";
import chalk from "chalk";
import { JsonRpcProvider, Wallet, formatEther } from "ethers";
import { resolveChain } from "./chains";
import { BatchTarget, loadBatchConfig } from "./batch-config";
import { planRpcs, resolveRpcsForChain } from "./rpc-resolver";
import { localPublicSnipe, SnipeResult } from "./local-mint";
import { toUtc8Time } from "./time-format";
import { askYesNo, closePrompts } from "./prompt";
import { walletKeysFromEnv } from "./wallet-keys";
import { promptKeys } from "./wizard";

function readConfig(path: string): any {
  let text: string;
  try {
    text = fs.readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`Could not read ${path}: ${(err as Error).message}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${(err as Error).message}`);
  }
}

export async function runBatch(configPath: string): Promise<void> {
  const raw = readConfig(configPath);

  const chain = resolveChain(raw?.chain);
  if (!chain) {
    throw new Error(`${configPath}: unsupported chain "${raw?.chain}". Use one of ethereum/base/robinhood.`);
  }

  console.log(chalk.bold.cyan(`\nBatch mode — ${chain.name} (${chain.chainId})`));

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

  // ── 2. Targets ────────────────────────────────────────────────────────
  console.log(chalk.bold.white("\nTargets"));
  const cfg = await loadBatchConfig(raw, chain, rpcPlan.urls);

  // ── 3. Wallets ────────────────────────────────────────────────────────
  console.log(chalk.bold.white("\nWallets"));
  const keys = cfg.walletSource === "env" ? walletKeysFromEnv() : await promptKeys();
  if (keys.length === 0) {
    throw new Error("No wallet keys — set PRIVATE_KEY/PRIVATE_KEYS in .env, or use \"walletSource\": \"prompt\".");
  }
  const wallets = keys.map((k) => new Wallet(k));

  const provider = new JsonRpcProvider(cfg.rpcUrls[0]);
  const gasReservePerTarget = BigInt(cfg.gasLimit) * cfg.maxFeePerGas;
  const requiredPerWallet = cfg.targets.reduce(
    (sum, t) => sum + t.plan.value + gasReservePerTarget,
    0n
  );

  const short: string[] = [];
  const balances = await Promise.all(
    wallets.map((w) => provider.getBalance(w.address).catch(() => null))
  );
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
      `Wallet(s) short of funds for all ${cfg.targets.length} target(s):\n  ${short.join("\n  ")}\n` +
        `  Each wallet needs ≥ ${formatEther(requiredPerWallet)} ${chain.nativeSymbol} (mint value + gasLimit × maxFee per target).`
    );
  }

  // ── 4. Schedule + one confirmation ────────────────────────────────────
  console.log(chalk.bold.white("\n──────── BATCH SCHEDULE ────────"));
  for (const t of cfg.targets) {
    console.log(
      `  ${chalk.white(toUtc8Time(t.startAt))} UTC+8  ${chalk.bold(t.label)}  ×${t.quantity}  ` +
        `${formatEther(t.plan.value)} ${chain.nativeSymbol}/wallet  cap ${formatEther(t.maxValueWei)}`
    );
  }
  console.log(
    chalk.gray(
      `  wallets ${wallets.length} | refresh T-${cfg.refreshBeforeMs}ms | on failure ${cfg.onFailure} | budget ${formatEther(requiredPerWallet)} ${chain.nativeSymbol}/wallet`
    )
  );
  console.log(chalk.bold.white("────────────────────────────────"));

  if (!(await askYesNo(chalk.bold("Run this batch unattended?"), false))) {
    console.log(chalk.yellow("\n  Cancelled — nothing was sent.\n"));
    closePrompts();
    return;
  }

  // Hand stdin back so readline never interleaves with the blast logging.
  closePrompts();

  // ── 5. Execute targets in start-time order ────────────────────────────
  const summary: { target: BatchTarget; results: SnipeResult[] }[] = [];

  for (const t of cfg.targets) {
    if (t.plan.drop.endTime * 1000 <= Date.now()) {
      console.log(chalk.yellow(`\n━━━ ${t.label} — public stage already ended, skipping ━━━`));
      summary.push({
        target: t,
        results: wallets.map((w, idx) => ({ idx, address: w.address, txHash: null, status: "SKIPPED" as const })),
      });
      continue;
    }

    console.log(chalk.bold.magenta(`\n━━━ ${t.label} (${t.contract}) ━━━`));

    let results: SnipeResult[];
    try {
      results = await localPublicSnipe({
        nftContract: t.contract,
        quantity: t.quantity,
        walletKeys: keys,
        rpcUrls: cfg.rpcUrls,
        maxFeePerGas: cfg.maxFeePerGas,
        maxPriorityFee: cfg.maxPriorityFee,
        gasLimit: cfg.gasLimit,
        targetStart: t.startAt.getTime() > Date.now() ? t.startAt : null,
        plan: t.plan,
        maxValueWei: t.maxValueWei,
        refreshBeforeMs: cfg.refreshBeforeMs,
      });
    } catch (err) {
      console.log(chalk.bold.red(`  ✗ ${t.label} failed: ${(err as Error).message}`));
      results = wallets.map((w, idx) => ({ idx, address: w.address, txHash: null, status: "REJECTED" as const }));
    }

    summary.push({ target: t, results });

    if (cfg.onFailure === "stop" && !results.some((r) => r.status === "SUCCESS")) {
      console.log(chalk.bold.yellow(`\n  onFailure=stop — no success on ${t.label}, ending the batch here.`));
      break;
    }
  }

  // ── 6. Summary ────────────────────────────────────────────────────────
  console.log(chalk.bold.white("\n════════ BATCH SUMMARY ════════"));
  for (const { target, results } of summary) {
    for (const r of results) {
      const color =
        r.status === "SUCCESS"
          ? chalk.green
          : r.status === "SKIPPED" || r.status === "TIMEOUT"
            ? chalk.yellow
            : chalk.red;
      console.log(color(`  ${target.label}  [W${r.idx}]  ${r.status}  ${r.txHash ?? ""}`));
    }
  }
  console.log(chalk.bold.white("═══════════════════════════════\n"));
}
