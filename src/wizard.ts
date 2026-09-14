// Interactive public-mint wizard.
//
// Every transaction here is built from on-chain SeaDrop state — price, fee
// recipient and per-wallet cap all come from the contract — so no OpenSea
// account, token or API key is involved in the mint itself.
//
// CLI-pasted keys live in memory; loading keys from .env is optional.

import chalk from "chalk";
import { walletKeysFromEnv } from "./wallet-keys";
import { JsonRpcProvider, Wallet, formatEther, getAddress, isAddress } from "ethers";
import { CHAINS, ChainProfile, resolveChain } from "./chains";
import { parseNftLink } from "./nft-link";
import { resolveSlug } from "./slug-resolver";
import {
  maskRpc,
  planRpcs,
  privateRpcsFromEnv,
  resolveRpcsForChain,
  toRpcUrl,
} from "./rpc-resolver";
import { parseRpcEndpoints } from "./rpc-blast";
import { buildLocalMintPlan, LocalMintPlan } from "./seadrop-public";
import { localPublicSnipe } from "./local-mint";
import { detectPresale, runAllowlistWizard } from "./allowlist";
import { utc8TimeToDate, toUtc8Time } from "./time-format";
import { askChoice, askHidden, askNumber, askText, askYesNo, closePrompts } from "./prompt";

export async function runWizard(): Promise<void> {
  printBanner();

  // ── 1. Private keys ───────────────────────────────────────────────────
  const walletKeys = await promptKeys();

  // ── 2. Chain ──────────────────────────────────────────────────────────
  let chainKey = await askChoice<string>(
    "Select blockchain",
    CHAINS.map((c) => ({ label: c.name, value: c.key, hint: `chain id ${c.chainId}` })),
    Math.max(
      0,
      CHAINS.findIndex((c) => c.key === (process.env.CHAIN || "base").toLowerCase())
    )
  );

  // ── 3. Quantity ───────────────────────────────────────────────────────
  const quantity = await promptQuantity(walletKeys.length);

  // ── 4. NFT link ───────────────────────────────────────────────────────
  const target = await promptTarget(chainKey);
  const nftContract = target.contract;
  chainKey = target.chainKey;
  const chainProfile = resolveChain(chainKey)!;

  if (target.slug && process.env.OPENSEA_API_KEY?.trim()) {
    console.log(chalk.gray("  Auto-checking OpenSea for a live mint stage..."));
    if (await detectPresale(target.slug, nftContract, chainKey)) {
      console.log(chalk.green("  ✓ An Allowlist/WL FCFS stage is live or coming up — wallets will be checked, and the next stage will be awaited if mint is rejected."));
      for (const key of walletKeys) {
        await runAllowlistWizard(false, { slug: target.slug, key, quantity });
      }
      return;
    }
    console.log(chalk.gray("  No presale stage is live; reading the on-chain Public schedule."));
  } else {
    console.log(chalk.yellow("  Reading on-chain Public only. Auto-detecting Allowlist requires a collection link/slug and OPENSEA_API_KEY in .env."));
  }

  // ── 5. RPC endpoints ──────────────────────────────────────────────────
  const manualRpcs = await promptRpc(chainProfile);
  const { urls: candidateRpcs, source } = resolveRpcsForChain(chainKey, manualRpcs);
  console.log(chalk.gray(`  Source: ${source}`));
  console.log(chalk.gray(`  Probing ${candidateRpcs.length} endpoint(s)...`));

  const plan = await planRpcs(candidateRpcs, chainProfile.chainId);

  for (const bad of plan.dropped) {
    const wrong = resolveChain(bad.chainId);
    console.log(
      chalk.red(`    ✗ ${labelOf(bad.url)} is on chain ${bad.chainId}${wrong ? ` (${wrong.name})` : ""} — dropped`)
    );
  }
  for (const ep of parseRpcEndpoints(plan.urls)) {
    const failure = plan.failures.find((f) => f.url === ep.url);
    if (failure) {
      const benign = /not allowed|does not exist|not supported|method not found/i.test(failure.message);
      console.log(
        benign
          ? chalk.gray(`    • ${ep.label}  (send-only)`)
          : chalk.yellow(`    ⚠ ${ep.label}  ${failure.message.slice(0, 90)}`)
      );
    } else {
      console.log(chalk.green(`    ✓ ${ep.label}`));
    }
  }

  if (plan.urls.length === 0) {
    throw new Error(`No usable RPC endpoint for ${chainProfile.name}`);
  }
  if (!plan.verified) {
    console.log(chalk.yellow(`  ⚠ No endpoint confirmed chain ID ${chainProfile.chainId}.`));
    if (!(await askYesNo("Continue anyway?", false))) {
      throw new Error("Cancelled — could not verify the RPC's chain");
    }
  } else {
    console.log(chalk.green(`  ✓ Confirmed chain ID ${chainProfile.chainId} (${chainProfile.name})`));
  }
  const rpcUrls = plan.urls;

  // ── 6. Read the public drop from chain ────────────────────────────────
  console.log(chalk.bold.white("\nMint stage"));
  const mintPlan = await buildLocalMintPlan(rpcUrls[0], nftContract, quantity);
  if (!mintPlan) {
    throw new Error(
      `Could not read a SeaDrop public stage for ${nftContract} on ${chainProfile.name}.\n` +
        "  This may not be a SeaDrop collection, or the config lives on the token contract itself."
    );
  }

  const drop = mintPlan.drop;
  const startsAt = new Date(drop.startTime * 1000);
  const endsAt = new Date(drop.endTime * 1000);
  const live = Date.now() >= startsAt.getTime() && Date.now() < endsAt.getTime();

  console.log(chalk.green("  ✓ Calldata built from on-chain SeaDrop — no OpenSea token needed"));
  console.log(chalk.gray(`    Fee recipient: ${mintPlan.feeRecipient}`));
  console.log(
    chalk.gray(
      `    Price:         ${formatEther(drop.mintPrice)} × ${quantity} = ${formatEther(mintPlan.value)} per wallet`
    )
  );
  console.log(chalk.gray(`    Per-wallet cap: ${drop.maxTotalMintableByWallet || "unlimited"}`));
  console.log(
    chalk.gray(
      `    Time:          ${toUtc8Time(startsAt)} → ${toUtc8Time(endsAt)} UTC+8  ${live ? chalk.green("(live)") : chalk.yellow(`(starts in ${formatRemaining(startsAt.getTime() - Date.now())})`)}`
    )
  );

  if (drop.maxTotalMintableByWallet > 0 && quantity > drop.maxTotalMintableByWallet) {
    console.log(
      chalk.yellow(`  ⚠ This stage allows at most ${drop.maxTotalMintableByWallet} NFT(s) per wallet — minting ${quantity} will revert.`)
    );
  }
  if (Date.now() >= endsAt.getTime()) {
    console.log(chalk.yellow("  ⚠ This public mint stage has already ended on-chain."));
  }

  // ── 7. Gas ────────────────────────────────────────────────────────────
  const provider = new JsonRpcProvider(rpcUrls[0]);
  console.log(chalk.bold.white("\nGas"));
  const baseFeeGwei = await currentBaseFeeGwei(provider);
  if (baseFeeGwei !== null) {
    console.log(chalk.gray(`  Current network base fee: ${baseFeeGwei.toFixed(6)} gwei`));
  }

  const envMaxFee = Number(process.env.MAX_FEE_PER_GAS || (chainKey === "ethereum" ? 80 : 2));
  const envPriority = Number(process.env.MAX_PRIORITY_FEE || (chainKey === "ethereum" ? 5 : 0.05));

  // A ceiling under the base fee is rejected outright by every node, so it must
  // not be enterable at all.
  let defaultMaxFee = envMaxFee;
  if (baseFeeGwei !== null) {
    const suggested = Math.ceil((baseFeeGwei * 2 + envPriority) * 1000) / 1000;
    if (envMaxFee < baseFeeGwei) defaultMaxFee = suggested;
    console.log(chalk.gray(`  Must be at least ${baseFeeGwei.toFixed(6)} gwei; ${suggested} leaves headroom.`));
  }

  const maxFeeGwei = await askNumber("Max gas fee (gwei) — ceiling", defaultMaxFee, {
    min: baseFeeGwei ?? 0,
  });

  // EIP-1559 caps the tip at the ceiling; ethers refuses to sign otherwise.
  const priorityDefault = Math.min(envPriority, maxFeeGwei);
  const priorityGwei = await askNumber("Priority fee / tip (gwei)", priorityDefault, {
    min: 0,
    max: maxFeeGwei,
  });

  const maxFeePerGas = gweiToWei(maxFeeGwei);
  const maxPriorityFee = gweiToWei(priorityGwei);
  const gasLimit = parseInt(process.env.GAS_LIMIT || "0", 10) || 250_000;

  // ── 8. Timing ─────────────────────────────────────────────────────────
  const { targetStart, timingLabel } = await promptTiming(drop.startTime);

  // ── 9. Balances + affordability ───────────────────────────────────────
  console.log(chalk.bold.white("\nWallets"));
  const wallets = walletKeys.map((k) => new Wallet(k));
  const balances = await Promise.all(
    wallets.map((w) => provider.getBalance(w.address).catch(() => null))
  );
  const symbol = chainProfile.nativeSymbol;

  // Nodes reserve gasLimit × maxFee + value upfront and reject if the balance
  // falls short, regardless of the far smaller amount actually spent.
  const required = BigInt(gasLimit) * maxFeePerGas + mintPlan.value;

  wallets.forEach((w, i) => {
    const bal = balances[i];
    const text = bal === null ? "balance unreadable" : `${Number(formatEther(bal)).toFixed(6)} ${symbol}`;
    const short = bal !== null && bal < required;
    const line = `  [W${i}] ${w.address}  ${text}`;
    console.log(short ? chalk.red(`${line}  ✗ needs ${formatEther(required)}`) : chalk.gray(line));
  });

  const shortWallets = wallets.filter((_, i) => balances[i] !== null && (balances[i] as bigint) < required);
  if (shortWallets.length > 0) {
    console.log(
      chalk.gray(
        `\n  Nodes require each wallet to hold gasLimit × maxFee${mintPlan.value > 0n ? " + mint amount" : ""} = ${formatEther(required)} ${symbol}.`
      )
    );
    const poorest = balances
      .filter((b): b is bigint => b !== null)
      .reduce((a, b) => (a < b ? a : b));
    const affordable = Number((poorest - mintPlan.value) / BigInt(gasLimit)) / 1e9;
    if (affordable > 0) {
      console.log(
        chalk.yellow(`  Top up or rerun with a max fee no higher than ${affordable.toFixed(4)} gwei.`)
      );
    }
    if (shortWallets.length === wallets.length) {
      throw new Error("All wallets are short of funds — no transactions can be sent.");
    }
    console.log(chalk.yellow("  Wallets with sufficient balance can still send."));
  }

  // ── 10. Confirm ───────────────────────────────────────────────────────
  console.log(chalk.bold.white("\n──────── READY ────────"));
  line("Chain", `${chainProfile.name} (${chainProfile.chainId})`);
  line("RPC", `${labelOf(rpcUrls[0])} + ${rpcUrls.length - 1} more`);
  line("Target", target.label);
  line("Contract", nftContract);
  line("Wallets", `${wallets.length}`);
  line("Quantity", `${quantity} per wallet → ${quantity * wallets.length} total`);
  line(
    "Mint value",
    `${formatEther(mintPlan.value)} per wallet → ${formatEther(mintPlan.value * BigInt(wallets.length))} total (+ gas)`
  );
  line("Gas", `${maxFeeGwei} / ${priorityGwei} gwei · limit ${gasLimit}`);
  line("Timing", timingLabel);
  console.log(chalk.bold.white("───────────────────────"));

  if (!(await askYesNo(chalk.bold("Send transactions?"), false))) {
    console.log(chalk.yellow("\n  Cancelled — nothing was sent.\n"));
    closePrompts();
    return;
  }

  // Hand stdin back so readline never interleaves with the blast logging.
  closePrompts();

  await localPublicSnipe({
    nftContract,
    quantity,
    walletKeys,
    rpcUrls,
    maxFeePerGas,
    maxPriorityFee,
    gasLimit,
    targetStart,
    plan: mintPlan,
  });
}

// ── Steps ───────────────────────────────────────────────────────────────

async function promptKeys(): Promise<string[]> {
  console.log(chalk.bold.white("Private keys"));
  const source = await askChoice("Private key source", [
    { label: "Paste keys hidden in CLI", value: "paste", hint: "RAM only" },
    { label: "Load keys from .env", value: "env", hint: "PRIVATE_KEY or PRIVATE_KEYS" },
  ]);
  if (source === "env") {
    try {
      const keys = walletKeysFromEnv();
      if (keys.length > 0) {
        keys.forEach((key, i) => console.log(chalk.green(`  ✓ [W${i}] ${new Wallet(key).address}`)));
        console.log(chalk.gray(`  Loaded ${keys.length} wallet(s) from .env.`));
        return keys;
      }
      console.log(chalk.yellow("  No PRIVATE_KEY or PRIVATE_KEYS in .env. Paste keys below."));
    } catch (err) {
      console.log(chalk.red(`  ✗ ${(err as Error).message} Paste keys below.`));
    }
  }
  console.log(chalk.gray("  Paste one key per line — input is hidden. Leave blank when done."));
  console.log(chalk.gray("  Each key is confirmed by its wallet address. Nothing is written to disk."));

  const keys: string[] = [];
  const seen = new Set<string>();

  for (;;) {
    const raw = await askHidden(chalk.gray(`  › key #${keys.length + 1}: `));
    if (!raw) {
      if (keys.length === 0) {
        console.log(chalk.red("  ✗ At least one key is required."));
        continue;
      }
      break;
    }

    const normalized = raw.startsWith("0x") ? raw : `0x${raw}`;
    let wallet: Wallet;
    try {
      wallet = new Wallet(normalized);
    } catch {
      console.log(chalk.red("  ✗ Invalid private key — try again."));
      continue;
    }

    if (seen.has(wallet.address.toLowerCase())) {
      console.log(chalk.yellow(`  ⚠ Duplicate of ${short(wallet.address)} — skipped.`));
      continue;
    }
    seen.add(wallet.address.toLowerCase());
    keys.push(normalized);
    console.log(chalk.green(`  ✓ [W${keys.length - 1}] ${wallet.address}`));
  }

  console.log(chalk.gray(`  Loaded ${keys.length} wallet(s).`));
  return keys;
}

async function promptQuantity(walletCount: number): Promise<number> {
  console.log(chalk.bold.white("\nQuantity"));
  const qty = await askNumber("NFTs per wallet", 1, { min: 1, max: 100 });
  if (walletCount > 1) {
    console.log(chalk.gray(`  → ${qty} × ${walletCount} wallets = ${qty * walletCount} total`));
  }
  return Math.floor(qty);
}

async function promptTarget(
  chainKey: string
): Promise<{ contract: string; label: string; chainKey: string; slug?: string }> {
  console.log(chalk.bold.white("\nTarget NFT"));
  console.log(chalk.gray("  Paste an OpenSea link (collection or NFT), a slug, or a contract address."));

  let activeChain = chainKey;

  for (;;) {
    const raw = await askText("NFT link");
    if (!raw) {
      console.log(chalk.red("  ✗ Paste a link, slug, or address."));
      continue;
    }

    let parsed;
    try {
      parsed = parseNftLink(raw);
    } catch (err: any) {
      console.log(chalk.red(`  ✗ ${err.message}`));
      continue;
    }

    if (parsed.chainHint && parsed.chainHint !== activeChain && resolveChain(parsed.chainHint)) {
      const hinted = resolveChain(parsed.chainHint)!;
      console.log(
        chalk.yellow(`  ⚠ The link is on ${hinted.name}, but you selected ${resolveChain(activeChain)!.name}.`)
      );
      if (await askYesNo(`Switch to ${hinted.name}?`, true)) {
        activeChain = hinted.key;
        console.log(chalk.green(`  ✓ Switched to ${hinted.name}`));
      }
    }

    if (parsed.kind === "address") {
      const normalized = normalizeAddress(parsed.value);
      if (!normalized) {
        console.log(chalk.red(`  ✗ "${parsed.value}" is not a 20-byte address.`));
        continue;
      }
      if (normalized.checksumWarning) {
        console.log(chalk.yellow("  ⚠ Mixed-case address fails EIP-55 checksum — possible typo."));
        if (!(await askYesNo("Use this address anyway?", false))) continue;
      }
      console.log(chalk.green(`  ✓ Contract address ${normalized.address}`));
      return { contract: normalized.address, label: short(normalized.address), chainKey: activeChain };
    }

    // Slug → address is a plain OpenSea REST lookup, which often answers without
    // a key. Always try; a key only makes it reliable. The mint itself never
    // touches OpenSea either way.
    const apiKey = (process.env.OPENSEA_API_KEY || "").trim();

    try {
      console.log(chalk.gray(`  Resolving slug "${parsed.value}"${apiKey ? "" : " (no API key — may be refused)"}...`));
      const info = await resolveSlug(parsed.value, apiKey || undefined, activeChain);
      const resolved = normalizeAddress(info.contractAddress);
      if (!resolved) {
        console.log(chalk.red(`  ✗ API returned an invalid address: ${info.contractAddress}`));
        continue;
      }
      console.log(chalk.green(`  ✓ ${info.name} → ${resolved.address}`));
      if (info.chain && resolveChain(info.chain) && info.chain !== activeChain) {
        console.log(chalk.yellow(`  ⚠ Listed on "${info.chain}", not "${activeChain}".`));
        if (await askYesNo(`Switch to ${resolveChain(info.chain)!.name}?`, true)) {
          activeChain = resolveChain(info.chain)!.key;
        }
      }
      return { contract: resolved.address, label: info.name || parsed.value, chainKey: activeChain, slug: parsed.value };
    } catch (err: any) {
      console.log(chalk.red(`  ✗ ${err.message}`));
      console.log(
        chalk.gray("    Paste the contract address directly (0x…) — this needs no API key.")
      );
      console.log(
        chalk.gray("    You can find it in the collection details or in an NFT's URL.")
      );
    }
  }
}

async function promptRpc(profile: ChainProfile): Promise<string[]> {
  console.log(chalk.bold.white("\nRPC endpoint"));
  console.log(chalk.gray("  Private RPCs (Alchemy / QuickNode / Infura) improve your odds in a competitive mint."));
  if (profile.rpc.alchemyHost) {
    console.log(chalk.gray(`  Paste a full URL or just an Alchemy key → https://${profile.rpc.alchemyHost}/v2/<key>`));
  }
  console.log(chalk.gray("  Separate multiple RPCs with commas to blast simultaneously."));

  const fromEnv = privateRpcsFromEnv(profile.key);
  if (fromEnv.length > 0) {
    console.log(chalk.gray(`  In .env: ${fromEnv.map(maskRpc).join(", ")}`));
    console.log(chalk.gray("  Leave blank = keep the .env value."));
  } else {
    console.log(chalk.yellow(`  No .env RPC for ${profile.name}. Leave blank = public nodes only.`));
  }

  for (;;) {
    const raw = await askText(`RPC for ${profile.name}`);
    if (!raw) return fromEnv;

    const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
    const urls: string[] = [];
    let bad = false;
    for (const part of parts) {
      const url = toRpcUrl(part, profile.key);
      if (!url) {
        console.log(chalk.red(`  ✗ "${part}" is not a valid URL or API key.`));
        bad = true;
        break;
      }
      urls.push(url);
    }
    if (bad || urls.length === 0) continue;

    for (const url of urls) console.log(chalk.green(`  ✓ ${maskRpc(url)}`));
    return urls;
  }
}

async function promptTiming(
  startTime: number
): Promise<{ targetStart: Date | null; timingLabel: string }> {
  const startsInFuture = startTime * 1000 > Date.now();
  const at = new Date(startTime * 1000);

  const choices: { label: string; value: "wait" | "now" | "custom"; hint?: string }[] = [];
  if (startsInFuture) {
    // Firing before the on-chain start reverts with NotActive, so it isn't
    // offered at all once a future start time is known.
    choices.push({
      label: "Wait for the mint to open",
      value: "wait",
      hint: `${toUtc8Time(at)} UTC+8 · in ${formatRemaining(at.getTime() - Date.now())} · send at T-0`,
    });
  } else {
    choices.push({ label: "Send now", value: "now", hint: "stage is live" });
  }
  choices.push({ label: "Custom time", value: "custom", hint: "HH:MM, 24h, UTC+8, today" });

  const pick = await askChoice("When to send the transaction?", choices, 0);

  if (pick === "wait") return { targetStart: at, timingLabel: `wait for mint — ${toUtc8Time(at)} UTC+8` };
  if (pick === "now") return { targetStart: null, timingLabel: "send immediately" };

  for (;;) {
    const raw = await askText("Time (HH:MM, 24h, UTC+8)");
    try {
      const custom = utc8TimeToDate(raw);
      if (custom.getTime() < startTime * 1000) {
        console.log(chalk.bold.red(`  ✗ This is before the mint opens (${toUtc8Time(at)} UTC+8) — the transaction will revert.`));
        if (!(await askYesNo("Use this time anyway?", false))) continue;
      }
      return { targetStart: custom, timingLabel: `custom — ${toUtc8Time(custom)} UTC+8` };
    } catch (err: any) {
      console.log(chalk.red(`  ✗ ${err.message}`));
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

// Accept an address in any case — explorer copy-pastes arrive case-mangled and
// hard-failing is worse. A mixed-case string failing EIP-55 is the typo signal.
function normalizeAddress(raw: string): { address: string; checksumWarning: boolean } | null {
  const value = raw.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) return null;
  const body = value.slice(2);
  const mixedCase = /[a-f]/.test(body) && /[A-F]/.test(body);
  return {
    address: getAddress(value.toLowerCase()),
    checksumWarning: mixedCase && !isAddress(value),
  };
}

async function currentBaseFeeGwei(provider: JsonRpcProvider): Promise<number | null> {
  try {
    const fee = await provider.getFeeData();
    const wei = fee.gasPrice ?? fee.maxFeePerGas;
    return wei === null || wei === undefined ? null : Number(wei) / 1e9;
  } catch {
    return null;
  }
}

function gweiToWei(gwei: number): bigint {
  return BigInt(Math.round(gwei * 1e9));
}

function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function short(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

function labelOf(url: string): string {
  return parseRpcEndpoints([url])[0].label;
}

function line(label: string, value: string): void {
  console.log(`  ${chalk.gray(label.padEnd(10))} ${chalk.white(value)}`);
}

function printBanner(): void {
  console.log(
    chalk.bold.cyan(`
╔═══════════════════════════════════════╗
║        NFT PUBLIC MINT SNIPER         ║
║   On-chain calldata · no OpenSea      ║
╚═══════════════════════════════════════╝`)
  );
  console.log(chalk.gray("  SeaDrop public stages only. Press Ctrl+C to exit anytime.\n"));
}