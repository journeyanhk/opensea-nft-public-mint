// Audit rendering and export.
//
// The export path reuses loadBatchConfig, so anything written here is by
// construction something the batch runner can execute.

import fs from "fs";
import chalk from "chalk";
import { formatEther } from "ethers";
import { resolveChain } from "../chains";
import { planRpcs, resolveRpcsForChain } from "../rpc-resolver";
import { loadBatchConfig } from "../batch-config";
import { toUtc8Time } from "../time-format";
import { AuditResult } from "./audit";
import { Grade } from "./score";

const GRADE_STYLE: Record<Grade, (text: string) => string> = {
  A: chalk.bold.green,
  B: chalk.yellow,
  C: chalk.bold.red,
  D: chalk.bold.magenta,
};

const short = (address: string): string =>
  address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;

const time = (unixSeconds: number | null): string =>
  unixSeconds === null ? "—" : toUtc8Time(new Date(unixSeconds * 1000));

export function renderAuditTable(results: AuditResult[]): string {
  const lines: string[] = [];
  lines.push(
    "GRADE  START (UTC+8)        CHAIN      TARGET                                PRICE       CAP   MINTED       LEFT   NOTES"
  );
  for (const r of results) {
    if (!r.applicable) {
      lines.push(
        `  -    ${"—".padEnd(19)} ${r.chainKey.padEnd(10)} ${(r.name ?? short(r.contract)).slice(0, 36).padEnd(36)}  ${r.notApplicableReason ?? "not applicable"}`
      );
      continue;
    }
    const price = formatEther(r.publicDrop!.mintPrice);
    const name = (r.name ?? r.contract).slice(0, 36);
    const left = r.maxSupply === null ? "?" : (r.maxSupply - r.totalMinted).toString();
    lines.push(
      `${GRADE_STYLE[r.grade.grade](r.grade.grade.padEnd(6))} ` +
        `${time(r.publicDrop!.startTime).padEnd(19)} ` +
        `${r.chainKey.padEnd(10)} ` +
        `${name.padEnd(36)}  ` +
        `${price.padEnd(10)}  ` +
        `${String(r.publicDrop!.maxTotalMintableByWallet).padEnd(4)}  ` +
        `${(r.totalMinted + (r.maxSupply ? "/" + r.maxSupply : "")).padEnd(12)} ` +
        `${left.padEnd(5)}  ` +
        `${r.grade.reason}`
    );
  }
  return lines.join("\n");
}

export function renderAuditDetail(results: AuditResult[]): string {
  const lines: string[] = [];
  for (const r of results) {
    lines.push("");
    lines.push(chalk.bold(`── ${r.name ?? r.contract} (${r.chainName}, ${short(r.contract)}) ──`));
    if (!r.applicable) {
      lines.push(`  ${r.notApplicableReason}`);
      continue;
    }
    const drop = r.publicDrop!;
    lines.push(
      `  grade ${GRADE_STYLE[r.grade.grade](r.grade.grade)} | upper ${GRADE_STYLE[r.grade.upperGrade](r.grade.upperGrade)} (${r.grade.upperReason}) | projected ${GRADE_STYLE[r.grade.projectedGrade](r.grade.projectedGrade)} (${r.grade.projectedReason})`
    );    lines.push(
      `  public ${time(drop.startTime)} → ${time(drop.endTime)} | price ${formatEther(drop.mintPrice)} | cap ${drop.maxTotalMintableByWallet} | signers ${r.signerCount}`
    );
    lines.push(
      `  minted ${r.totalMinted}${r.maxSupply ? `/${r.maxSupply}` : " (supply unpinned)"} | ${r.mintScan.totalTxs} txs | ${r.mintScan.uniqueMinters} minters | top share ${Math.round(r.mintScan.topMinterShare * 100)}%`
    );
    if (r.mintScan.stages.length > 0) {
      lines.push(
        "  stages: " +
          r.mintScan.stages
            .map((s) => `#${s.stage} ${s.tokens} (${s.uniqueMinters} wallets)`)
            .join(" | ")
      );
    }
    if (r.updates.length > 0) {
      const last = r.updates[r.updates.length - 1];
      lines.push(
        `  changes: ${r.updates.length} updates | price ×${r.changes.priceChanges} | start ×${r.changes.startChanges} | cap ×${r.changes.capChanges} | last at ${time(last.at)}`
      );
    }
    for (const wallet of r.walletMints) {
      lines.push(`  wallet ${short(wallet.address)} already minted ${wallet.minted}`);
    }
    if (r.grade.risks.length > 0) lines.push(chalk.yellow(`  risks: ${r.grade.risks.join("; ")}`));
    if (r.errors.length > 0) lines.push(chalk.gray(`  degraded: ${r.errors.join("; ")}`));
  }
  return lines.join("\n");
}

export function renderJson(results: AuditResult[]): string {
  return JSON.stringify(results, (_key, value) => (typeof value === "bigint" ? value.toString() : value), 2);
}

export interface ExportOptions {
  path: string;
  chainKey: string;
  quantity: number;
  maxPriceEth: string | "current";
  grades?: Grade[];
  force?: boolean; // overwrite an existing file
}

export interface ExportResult {
  accepted: number;
  rejected: { target: string; reason: string }[];
  schedule: string[];
}

export async function exportTargets(results: AuditResult[], opts: ExportOptions): Promise<ExportResult> {
  const grades = opts.grades ?? (["A", "B"] as Grade[]);
  const chain = resolveChain(opts.chainKey);
  if (!chain) throw new Error(`Unsupported chain "${opts.chainKey}"`);

  const selected = results.filter((r) => r.applicable && grades.includes(r.grade.grade));
  const raw: any = {
    chain: opts.chainKey,
    walletSource: "env",
    targets: selected.map((r) => {
      const current = formatEther(r.publicDrop!.mintPrice);
      return {
        slug: r.contract,
        quantity: opts.quantity,
        maxPriceEth: opts.maxPriceEth === "current" ? (current === "0.0" ? "0" : current) : opts.maxPriceEth,
        startAt: "auto",
      };
    }),
  };

  const rejected: { target: string; reason: string }[] = [];
  const { urls } = resolveRpcsForChain(chain.key);
  const rpcPlan = await planRpcs(urls, chain.chainId);
  if (!rpcPlan.verified) throw new Error(`No RPC endpoint confirmed chain ID ${chain.chainId}.`);

  try {
    await loadBatchConfig(raw, chain, rpcPlan.urls);
  } catch {
    // Validate one by one so a single bad target does not sink the file.
    const accepted: any[] = [];
    for (const target of raw.targets) {
      try {
        await loadBatchConfig({ ...raw, targets: [target] }, chain, rpcPlan.urls);
        accepted.push(target);
      } catch (err) {
        rejected.push({ target: target.slug, reason: (err as Error).message });
      }
    }
    raw.targets = accepted;
  }

  const cfg = raw.targets.length > 0 ? await loadBatchConfig(raw, chain, rpcPlan.urls) : null;
  // Never silently clobber a config the user may have edited.
  if (fs.existsSync(opts.path) && !opts.force) {
    throw new Error(`${opts.path} already exists — pass --force to overwrite it.`);
  }
  fs.writeFileSync(opts.path, JSON.stringify(raw, null, 2));

  const schedule = cfg
    ? cfg.targets.map(
        (t) =>
          `  ${toUtc8Time(t.startAt)} UTC+8  ${t.label}  ×${t.quantity}  ${formatEther(t.plan.value)} ${chain.nativeSymbol}/wallet  cap ${formatEther(t.maxValueWei)}`
      )
    : [];

  return { accepted: raw.targets.length, rejected, schedule };
}
