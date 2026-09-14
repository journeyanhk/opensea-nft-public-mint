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
import { vnTimeToDate, toVNTime } from "./time-format";
import { askChoice, askHidden, askNumber, askText, askYesNo, closePrompts } from "./prompt";

export async function runWizard(): Promise<void> {
  printBanner();

  // ── 1. Private keys ───────────────────────────────────────────────────
  const walletKeys = await promptKeys();

  // ── 2. Chain ──────────────────────────────────────────────────────────
  let chainKey = await askChoice<string>(
    "选择区块链",
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
    console.log(chalk.gray("  正在自动检查 OpenSea 上正在进行的 mint 轮次..."));
    if (await detectPresale(target.slug, nftContract, chainKey)) {
      console.log(chalk.green("  ✓ 存在当前或即将开始的 Allowlist/WL FCFS 轮次 — 将检查钱包，若 mint 被拒绝会自动等待下一轮。"));
      for (const key of walletKeys) {
        await runAllowlistWizard(false, { slug: target.slug, key, quantity });
      }
      return;
    }
    console.log(chalk.gray("  当前没有进行中的 presale 轮次；读取链上 Public 排期。"));
  } else {
    console.log(chalk.yellow("  仅读取链上 Public。自动识别 Allowlist 需要 collection 链接/slug 以及 .env 中的 OPENSEA_API_KEY。"));
  }

  // ── 5. RPC endpoints ──────────────────────────────────────────────────
  const manualRpcs = await promptRpc(chainProfile);
  const { urls: candidateRpcs, source } = resolveRpcsForChain(chainKey, manualRpcs);
  console.log(chalk.gray(`  来源: ${source}`));
  console.log(chalk.gray(`  正在检查 ${candidateRpcs.length} 个 endpoint...`));

  const plan = await planRpcs(candidateRpcs, chainProfile.chainId);

  for (const bad of plan.dropped) {
    const wrong = resolveChain(bad.chainId);
    console.log(
      chalk.red(`    ✗ ${labelOf(bad.url)} 属于链 ${bad.chainId}${wrong ? ` (${wrong.name})` : ""} — 已剔除`)
    );
  }
  for (const ep of parseRpcEndpoints(plan.urls)) {
    const failure = plan.failures.find((f) => f.url === ep.url);
    if (failure) {
      const benign = /not allowed|does not exist|not supported|method not found/i.test(failure.message);
      console.log(
        benign
          ? chalk.gray(`    • ${ep.label}  (仅发送)`)
          : chalk.yellow(`    ⚠ ${ep.label}  ${failure.message.slice(0, 90)}`)
      );
    } else {
      console.log(chalk.green(`    ✓ ${ep.label}`));
    }
  }

  if (plan.urls.length === 0) {
    throw new Error(`没有可用于 ${chainProfile.name} 的 RPC endpoint`);
  }
  if (!plan.verified) {
    console.log(chalk.yellow(`  ⚠ 没有 endpoint 确认 chain ID ${chainProfile.chainId}。`));
    if (!(await askYesNo("仍要继续吗？", false))) {
      throw new Error("已取消 — 无法验证 RPC 所属链");
    }
  } else {
    console.log(chalk.green(`  ✓ 已确认 chain ID ${chainProfile.chainId} (${chainProfile.name})`));
  }
  const rpcUrls = plan.urls;

  // ── 6. Read the public drop from chain ────────────────────────────────
  console.log(chalk.bold.white("\nmint 轮次"));
  const mintPlan = await buildLocalMintPlan(rpcUrls[0], nftContract, quantity);
  if (!mintPlan) {
    throw new Error(
      `无法在 ${chainProfile.name} 上读取 ${nftContract} 的 SeaDrop public 轮次。\n` +
        "  这可能不是 SeaDrop 集合，或配置保存在 token 合约自身。"
    );
  }

  const drop = mintPlan.drop;
  const startsAt = new Date(drop.startTime * 1000);
  const endsAt = new Date(drop.endTime * 1000);
  const live = Date.now() >= startsAt.getTime() && Date.now() < endsAt.getTime();

  console.log(chalk.green("  ✓ 已从链上 SeaDrop 生成 calldata — 无需 OpenSea token"));
  console.log(chalk.gray(`    费用接收方: ${mintPlan.feeRecipient}`));
  console.log(
    chalk.gray(
      `    价格:       ${formatEther(drop.mintPrice)} × ${quantity} = ${formatEther(mintPlan.value)} 每个钱包`
    )
  );
  console.log(chalk.gray(`    单钱包上限: ${drop.maxTotalMintableByWallet || "不限"}`));
  console.log(
    chalk.gray(
      `    时间:       ${toVNTime(startsAt)} → ${toVNTime(endsAt)} 越南时间 (UTC+7)  ${live ? chalk.green("(进行中)") : chalk.yellow(`(距开始 ${formatRemaining(startsAt.getTime() - Date.now())})`)}`
    )
  );

  if (drop.maxTotalMintableByWallet > 0 && quantity > drop.maxTotalMintableByWallet) {
    console.log(
      chalk.yellow(`  ⚠ 该轮次每个钱包最多只能 mint ${drop.maxTotalMintableByWallet} 个 NFT — 铸造 ${quantity} 个的交易将被 revert。`)
    );
  }
  if (Date.now() >= endsAt.getTime()) {
    console.log(chalk.yellow("  ⚠ 该 public mint 轮次已在链上结束。"));
  }

  // ── 7. Gas ────────────────────────────────────────────────────────────
  const provider = new JsonRpcProvider(rpcUrls[0]);
  console.log(chalk.bold.white("\nGas"));
  const baseFeeGwei = await currentBaseFeeGwei(provider);
  if (baseFeeGwei !== null) {
    console.log(chalk.gray(`  当前网络 base fee: ${baseFeeGwei.toFixed(6)} gwei`));
  }

  const envMaxFee = Number(process.env.MAX_FEE_PER_GAS || (chainKey === "ethereum" ? 80 : 2));
  const envPriority = Number(process.env.MAX_PRIORITY_FEE || (chainKey === "ethereum" ? 5 : 0.05));

  // A ceiling under the base fee is rejected outright by every node, so it must
  // not be enterable at all.
  let defaultMaxFee = envMaxFee;
  if (baseFeeGwei !== null) {
    const suggested = Math.ceil((baseFeeGwei * 2 + envPriority) * 1000) / 1000;
    if (envMaxFee < baseFeeGwei) defaultMaxFee = suggested;
    console.log(chalk.gray(`  最低 ${baseFeeGwei.toFixed(6)} gwei；建议 ${suggested} 留有余量。`));
  }

  const maxFeeGwei = await askNumber("最大 gas 费 (gwei) — 上限", defaultMaxFee, {
    min: baseFeeGwei ?? 0,
  });

  // EIP-1559 caps the tip at the ceiling; ethers refuses to sign otherwise.
  const priorityDefault = Math.min(envPriority, maxFeeGwei);
  const priorityGwei = await askNumber("优先费 / tip (gwei)", priorityDefault, {
    min: 0,
    max: maxFeeGwei,
  });

  const maxFeePerGas = gweiToWei(maxFeeGwei);
  const maxPriorityFee = gweiToWei(priorityGwei);
  const gasLimit = parseInt(process.env.GAS_LIMIT || "0", 10) || 250_000;

  // ── 8. Timing ─────────────────────────────────────────────────────────
  const { targetStart, timingLabel } = await promptTiming(drop.startTime);

  // ── 9. Balances + affordability ───────────────────────────────────────
  console.log(chalk.bold.white("\n钱包"));
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
    const text = bal === null ? "无法读取余额" : `${Number(formatEther(bal)).toFixed(6)} ${symbol}`;
    const short = bal !== null && bal < required;
    const line = `  [W${i}] ${w.address}  ${text}`;
    console.log(short ? chalk.red(`${line}  ✗ 需要 ${formatEther(required)}`) : chalk.gray(line));
  });

  const shortWallets = wallets.filter((_, i) => balances[i] !== null && (balances[i] as bigint) < required);
  if (shortWallets.length > 0) {
    console.log(
      chalk.gray(
        `\n  节点要求每个钱包持有 gasLimit × maxFee${mintPlan.value > 0n ? " + mint 金额" : ""} = ${formatEther(required)} ${symbol}。`
      )
    );
    const poorest = balances
      .filter((b): b is bigint => b !== null)
      .reduce((a, b) => (a < b ? a : b));
    const affordable = Number((poorest - mintPlan.value) / BigInt(gasLimit)) / 1e9;
    if (affordable > 0) {
      console.log(
        chalk.yellow(`  请充值或重新运行，将最大费用设为不超过 ${affordable.toFixed(4)} gwei。`)
      );
    }
    if (shortWallets.length === wallets.length) {
      throw new Error("所有钱包余额不足 — 无法发送交易。");
    }
    console.log(chalk.yellow("  余额充足的钱包仍可发送交易。"));
  }

  // ── 10. Confirm ───────────────────────────────────────────────────────
  console.log(chalk.bold.white("\n──────── 准备就绪 ────────"));
  line("区块链", `${chainProfile.name} (${chainProfile.chainId})`);
  line("RPC", `${labelOf(rpcUrls[0])} + 另外 ${rpcUrls.length - 1} 个`);
  line("目标", target.label);
  line("合约", nftContract);
  line("钱包数", `${wallets.length}`);
  line("数量", `${quantity} 每个钱包 → 共 ${quantity * wallets.length}`);
  line(
    "mint 金额",
    `${formatEther(mintPlan.value)} 每个钱包 → 共 ${formatEther(mintPlan.value * BigInt(wallets.length))} (+ gas)`
  );
  line("Gas", `${maxFeeGwei} / ${priorityGwei} gwei · limit ${gasLimit}`);
  line("时间", timingLabel);
  console.log(chalk.bold.white("───────────────────────"));

  if (!(await askYesNo(chalk.bold("发送交易？"), false))) {
    console.log(chalk.yellow("\n  已取消 — 未发送任何交易。\n"));
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
  console.log(chalk.bold.white("私钥"));
  const source = await askChoice("私钥来源", [
    { label: "在 CLI 中隐藏粘贴", value: "paste", hint: "仅保存在内存中" },
    { label: "使用 .env 中的私钥", value: "env", hint: "PRIVATE_KEY 或 PRIVATE_KEYS" },
  ]);
  if (source === "env") {
    try {
      const keys = walletKeysFromEnv();
      if (keys.length > 0) {
        keys.forEach((key, i) => console.log(chalk.green(`  ✓ [W${i}] ${new Wallet(key).address}`)));
        console.log(chalk.gray(`  已从 .env 加载 ${keys.length} 个钱包。`));
        return keys;
      }
      console.log(chalk.yellow("  .env 中没有 PRIVATE_KEY 或 PRIVATE_KEYS。请在下方粘贴私钥。"));
    } catch (err) {
      console.log(chalk.red(`  ✗ ${(err as Error).message} 请在下方粘贴私钥。`));
    }
  }
  console.log(chalk.gray("  每行粘贴一个私钥 — 输入内容会被隐藏。完成后留空回车。"));
  console.log(chalk.gray("  每个私钥通过钱包地址确认。不会向磁盘写入任何数据。"));

  const keys: string[] = [];
  const seen = new Set<string>();

  for (;;) {
    const raw = await askHidden(chalk.gray(`  › 第 ${keys.length + 1} 个私钥: `));
    if (!raw) {
      if (keys.length === 0) {
        console.log(chalk.red("  ✗ 至少需要输入一个私钥。"));
        continue;
      }
      break;
    }

    const normalized = raw.startsWith("0x") ? raw : `0x${raw}`;
    let wallet: Wallet;
    try {
      wallet = new Wallet(normalized);
    } catch {
      console.log(chalk.red("  ✗ 私钥无效 — 请重试。"));
      continue;
    }

    if (seen.has(wallet.address.toLowerCase())) {
      console.log(chalk.yellow(`  ⚠ 与 ${short(wallet.address)} 重复 — 已跳过。`));
      continue;
    }
    seen.add(wallet.address.toLowerCase());
    keys.push(normalized);
    console.log(chalk.green(`  ✓ [W${keys.length - 1}] ${wallet.address}`));
  }

  console.log(chalk.gray(`  已加载 ${keys.length} 个钱包。`));
  return keys;
}

async function promptQuantity(walletCount: number): Promise<number> {
  console.log(chalk.bold.white("\n数量"));
  const qty = await askNumber("每个钱包的 NFT 数量", 1, { min: 1, max: 100 });
  if (walletCount > 1) {
    console.log(chalk.gray(`  → ${qty} × ${walletCount} 个钱包 = 共 ${qty * walletCount}`));
  }
  return Math.floor(qty);
}

async function promptTarget(
  chainKey: string
): Promise<{ contract: string; label: string; chainKey: string; slug?: string }> {
  console.log(chalk.bold.white("\n目标 NFT"));
  console.log(chalk.gray("  粘贴 OpenSea 链接（集合或 NFT）、slug 或合约地址。"));

  let activeChain = chainKey;

  for (;;) {
    const raw = await askText("NFT 链接");
    if (!raw) {
      console.log(chalk.red("  ✗ 请粘贴链接、slug 或地址。"));
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
        chalk.yellow(`  ⚠ 该链接属于 ${hinted.name}，但您选择的是 ${resolveChain(activeChain)!.name}。`)
      );
      if (await askYesNo(`切换到 ${hinted.name}？`, true)) {
        activeChain = hinted.key;
        console.log(chalk.green(`  ✓ 已切换到 ${hinted.name}`));
      }
    }

    if (parsed.kind === "address") {
      const normalized = normalizeAddress(parsed.value);
      if (!normalized) {
        console.log(chalk.red(`  ✗ "${parsed.value}" 不是 20 字节地址。`));
        continue;
      }
      if (normalized.checksumWarning) {
        console.log(chalk.yellow("  ⚠ 大小写地址的 EIP-55 校验和不匹配 — 可能输入有误。"));
        if (!(await askYesNo("仍要使用该地址吗？", false))) continue;
      }
      console.log(chalk.green(`  ✓ 合约地址 ${normalized.address}`));
      return { contract: normalized.address, label: short(normalized.address), chainKey: activeChain };
    }

    // Slug → address is a plain OpenSea REST lookup, which often answers without
    // a key. Always try; a key only makes it reliable. The mint itself never
    // touches OpenSea either way.
    const apiKey = (process.env.OPENSEA_API_KEY || "").trim();

    try {
      console.log(chalk.gray(`  正在解析 slug "${parsed.value}"${apiKey ? "" : "（没有 API key — 可能被拒绝）"}...`));
      const info = await resolveSlug(parsed.value, apiKey || undefined, activeChain);
      const resolved = normalizeAddress(info.contractAddress);
      if (!resolved) {
        console.log(chalk.red(`  ✗ API 返回了无效地址: ${info.contractAddress}`));
        continue;
      }
      console.log(chalk.green(`  ✓ ${info.name} → ${resolved.address}`));
      if (info.chain && resolveChain(info.chain) && info.chain !== activeChain) {
        console.log(chalk.yellow(`  ⚠ 该集合在 "${info.chain}" 上架，而不是 "${activeChain}"。`));
        if (await askYesNo(`切换到 ${resolveChain(info.chain)!.name}？`, true)) {
          activeChain = resolveChain(info.chain)!.key;
        }
      }
      return { contract: resolved.address, label: info.name || parsed.value, chainKey: activeChain, slug: parsed.value };
    } catch (err: any) {
      console.log(chalk.red(`  ✗ ${err.message}`));
      console.log(
        chalk.gray("    请直接粘贴合约地址 (0x…) — 这种方式不需要 API key。")
      );
      console.log(
        chalk.gray("    可以在集合详情或 NFT 的 URL 中找到地址。")
      );
    }
  }
}

async function promptRpc(profile: ChainProfile): Promise<string[]> {
  console.log(chalk.bold.white("\nRPC endpoint"));
  console.log(chalk.gray("  私有 RPC（Alchemy / QuickNode / Infura）能在竞争激烈的 mint 中提高成功率。"));
  if (profile.rpc.alchemyHost) {
    console.log(chalk.gray(`  粘贴完整 URL 或仅 Alchemy key → https://${profile.rpc.alchemyHost}/v2/<key>`));
  }
  console.log(chalk.gray("  用逗号分隔多个 RPC，以便并发广播。"));

  const fromEnv = privateRpcsFromEnv(profile.key);
  if (fromEnv.length > 0) {
    console.log(chalk.gray(`  .env 中已有: ${fromEnv.map(maskRpc).join(", ")}`));
    console.log(chalk.gray("  留空 = 保留 .env 中的值。"));
  } else {
    console.log(chalk.yellow(`  .env 中没有 ${profile.name} 的 RPC。留空 = 仅使用公共节点。`));
  }

  for (;;) {
    const raw = await askText(`${profile.name} 的 RPC`);
    if (!raw) return fromEnv;

    const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
    const urls: string[] = [];
    let bad = false;
    for (const part of parts) {
      const url = toRpcUrl(part, profile.key);
      if (!url) {
        console.log(chalk.red(`  ✗ "${part}" 不是有效的 URL 或 API key。`));
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
      label: "等待 mint 开始",
      value: "wait",
      hint: `${toVNTime(at)} 越南时间 (UTC+7) · 还剩 ${formatRemaining(at.getTime() - Date.now())} · T-0 发送`,
    });
  } else {
    choices.push({ label: "立即发送", value: "now", hint: "mint 正在进行" });
  }
  choices.push({ label: "自定义时间", value: "custom", hint: "HH:MM，24 小时制，越南时间 (UTC+7)，今天" });

  const pick = await askChoice("何时发送交易？", choices, 0);

  if (pick === "wait") return { targetStart: at, timingLabel: `等待 mint 开始 — ${toVNTime(at)} 越南时间 (UTC+7)` };
  if (pick === "now") return { targetStart: null, timingLabel: "立即发送" };

  for (;;) {
    const raw = await askText("时间 (HH:MM, 24 小时制, 越南时间 (UTC+7))");
    try {
      const custom = vnTimeToDate(raw);
      if (custom.getTime() < startTime * 1000) {
        console.log(chalk.bold.red(`  ✗ 该时间早于 mint 开始时间 (${toVNTime(at)} 越南时间 (UTC+7)) — 交易将 revert。`));
        if (!(await askYesNo("仍要使用该时间吗？", false))) continue;
      }
      return { targetStart: custom, timingLabel: `自定义 — ${toVNTime(custom)} 越南时间 (UTC+7)` };
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
  console.log(chalk.gray("  仅支持 SeaDrop public 轮次。随时按 Ctrl+C 退出。\n"));
}
