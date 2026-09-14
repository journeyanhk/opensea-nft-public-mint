// Public-mint execution with no OpenSea in the loop.
//
// Because the calldata is known ahead of time (see seadrop-public.ts), every
// transaction can be signed and serialised *before* the stage opens. At T-0 the
// only work left is writing bytes to sockets — no API poll, no signing, no
// encoding. That is strictly faster than the OpenSea path, which cannot sign
// until the API hands over calldata roughly a second after the stage starts.

import chalk from "chalk";
import { performance } from "perf_hooks";
import { JsonRpcProvider, Wallet, formatEther } from "ethers";
import { blastToAll, parseRpcEndpoints, prepareBlast, waitForReceipt, PreparedBlast } from "./rpc-blast";
import { warmConnections } from "./connection-warmer";
import { waitForMintTime } from "./timer";
import { explorerTx } from "./chains";
import { LocalMintPlan } from "./seadrop-public";

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
}

export async function localPublicSnipe(opts: LocalSnipeOpts): Promise<void> {
  const {
    nftContract, quantity, walletKeys, rpcUrls,
    maxFeePerGas, maxPriorityFee, gasLimit, targetStart, plan,
  } = opts;

  const provider = new JsonRpcProvider(rpcUrls[0]);
  const endpoints = parseRpcEndpoints(rpcUrls);
  const wallets = walletKeys.map((k) => new Wallet(k, provider));

  console.log(chalk.bold.magenta("\n── 本地 PUBLIC MINT（不使用 OpenSea）──"));
  console.log(chalk.gray(`  SeaDrop:       ${plan.to}`));
  console.log(chalk.gray(`  NFT:           ${nftContract}`));
  console.log(chalk.gray(`  费用接收方:    ${plan.feeRecipient}`));
  console.log(
    chalk.gray(
      `  价格:          ${formatEther(plan.drop.mintPrice)} × ${quantity} = ${formatEther(plan.value)} 每个钱包`
    )
  );
  console.log(chalk.gray(`  Calldata:      ${(plan.data.length - 2) / 2} 字节（所有钱包相同）`));

  // ── Warm sockets and pre-fetch everything the signature depends on ──
  await warmConnections(rpcUrls);

  const [nonces, network] = await Promise.all([
    Promise.all(wallets.map((w) => provider.getTransactionCount(w.address, "pending"))),
    provider.getNetwork(),
  ]);
  const chainId = network.chainId;
  console.log(chalk.gray(`  Nonces: [${nonces.join(", ")}] | chainId: ${chainId}`));

  // ── Sign everything now, well before the stage opens ──
  const signStart = performance.now();
  const prepared: { idx: number; address: string; blast: PreparedBlast }[] = [];

  for (let i = 0; i < wallets.length; i++) {
    const rawTx = await wallets[i].signTransaction({
      to: plan.to,
      data: plan.data,
      value: plan.value,
      nonce: nonces[i],
      maxFeePerGas,
      maxPriorityFeePerGas: maxPriorityFee,
      gasLimit: gasLimit || 250_000,
      type: 2,
      chainId,
    });
    prepared.push({ idx: i, address: wallets[i].address, blast: prepareBlast(rawTx) });
  }

  console.log(
    chalk.green(
      `  ✓ 已在 ${(performance.now() - signStart).toFixed(1)}ms 内签名并序列化 ${prepared.length} 笔交易 — 到点发送时不再有任何计算`
    )
  );

  // ── Wait for the stage, then blast pre-built bytes ──
  if (targetStart) {
    await waitForMintTime(targetStart, 0);
  } else {
    console.log(chalk.bold.yellow("\n  🚀 立即发送..."));
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
    chalk.bold.green(`  已发送 ${fired.length} 笔交易 (${dispatchMs}ms, 开售后 +${sinceStage}ms)`)
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
    console.log(chalk.bold.red(`\n  ✗ [W${idx}] 被所有 RPC 拒绝 — 未广播到网络。`));
    for (const reason of reasons) console.log(chalk.red(`      ${reason}`));
    if (reasons.some((r) => (r ?? "").includes("less than block base fee"))) {
      console.log(chalk.yellow("      → 最大费用低于链的 base fee。请提高费用后重试。"));
    }
  }

  if (accepted.length === 0) {
    console.log(chalk.bold.red("\n===== 没有交易被广播 — 无可等待的回执 =====\n"));
    return;
  }

  // ── Receipts (only for txs an endpoint actually accepted) ──
  console.log(chalk.gray("\n  正在等待 receipt..."));
  await Promise.all(
    accepted.map(async ({ idx, txHash }) => {
      const receipt = await waitForReceipt(txHash, rpcUrls[0], 60_000);
      if (!receipt) {
        console.log(chalk.yellow(`  [W${idx}] 等待超时 — 请检查: ${explorerTx(chainId, txHash)}`));
        return;
      }
      const color = receipt.status === "成功" ? chalk.bold.green : chalk.bold.red;
      console.log(
        color(`  [W${idx}] Block: ${receipt.block} | Pos: ${receipt.position} | ${receipt.status} | Gas: ${receipt.gasUsed}`)
      );
      console.log(chalk.gray(`  [W${idx}] 查看: ${explorerTx(chainId, txHash)}`));
    })
  );

  console.log(chalk.bold.white("\n===== 本地 PUBLIC MINT 完成 ====="));
}
