// Static dashboard: one HTML file generated from the local scan state, the audit
// history and the execution ledger. No server, no external assets, no network.
//
// Everything dynamic is escaped; the filtering, sorting and shortlist generation
// are a few lines of inline vanilla JS.

import fs from "fs";
import { formatEther } from "ethers";
import { resolveChain } from "../chains";
import { CachedScan, readCachedScan } from "../audit/audit";
import { Ledger, entryOf } from "../batch-ledger";
import { BackfillRecord, formatNetUsd } from "./backfill";
import { liquidityVerdict, LiquidityLevel } from "./valuation";
import { ContractEntry, ScanState } from "./state";
import { creatorStatsFor, qualityScore, safeImageUrl, safeLinkUrl } from "./quality";
import { freshest, isPriceFlip } from "./price-watch";
import type { CreatorFact, CreatorStats, Phase, Penalty, QualityDimension, QualityResult, QualitySignals, SocialFact } from "./quality";
import type { CalendarFacts } from "./calendar";
import { emptyFavorites, favoriteKey, FavoritesStore } from "./favorites";
import type { QueueJob } from "../executor/queue";
import { FAVORITES_CLIENT } from "./panel-client";
import { toUtc8Time } from "../time-format";

export type { Phase };

export interface HistoryLine {
  at: string;
  chain: string;
  contract: string;
  grade: string;
  remaining: string | null;
  projected: string | null;
  start: number | null;
  risks?: string[];
  reason?: string;
  coverage?: number;
  slug?: string | null;
  name?: string | null;
  owner?: string | null;
  mintPriceWei?: string | null;
  capPerWallet?: number | null;
  endTime?: number | null;
  maxSupply?: string | null;
  totalMinted?: string | null;
  recent15m?: string | null;
  recent1h?: string | null;
  uniqueMinters?: number | null;
  topMinterShare?: number | null;
  stageCount?: number | null;
  presaleStages?: number | null;
  maxTxTokens?: string | null;
  payerDiffers?: number | null;
  smartMinters?: number | null;
}

export interface GradePoint {
  at: string;
  grade: string;
  remaining: string | null;
  projected: string | null;
  start: number | null;
  risks?: string[];
  minted?: string | null;
  slug?: string | null;
  name?: string | null;
  owner?: string | null;
  mintPriceWei?: string | null;
  capPerWallet?: number | null;
  endTime?: number | null;
  maxSupply?: string | null;
  recent15m?: string | null;
  recent1h?: string | null;
  uniqueMinters?: number | null;
  topMinterShare?: number | null;
  presaleStages?: number | null;
  maxTxTokens?: string | null;
  payerDiffers?: number | null;
  smartMinters?: number | null;
}

export interface DashboardRow {
  chain: string;
  contract: string;
  start: number | null;
  grade: string | null;
  gradeHistory: GradePoint[];
  remaining: string | null;
  projected: string | null;
  lastAuditedAt: string | null;
  pendingAudit: boolean;
  soldOut: boolean;
  execution: { status: string; txHash: string | null; at: string; quantity: number; mintedCount: number | null } | null;
  stages: { stage: number; tokens: string; minters: number }[];
  topMinterShare: number | null;
  nets: Record<string, string>; // checkpoint hours -> net in native units
  notes: string[];
  slug: string | null;
  name: string | null;
  owner: string | null;
  mintPriceWei: string | null;
  capPerWallet: number | null;
  endTime: number | null;
  maxSupply: string | null;
  minted: string | null;
  recent15m: string | null;
  recent1h: string | null;
  uniqueMinters: number | null;
  presaleStages: number | null;
  velocity24h: string | null;
  velocitySource: "differential" | "bucket" | null;
  sellOutEtaHours: number | null;
  stale: boolean;
  phase: Phase;
  presaleShare: number | null;
  batchMint: boolean;
  priceFlip: boolean;
  priceHistory: { at: string; priceWei: string; cap: number | null }[];
  liquidity: { level: LiquidityLevel; label: string } | null;
  maxTxTokens: string | null;
  payerDiffers: number | null;
  smartMinters: number | null;
  calendar: CalendarFacts | null;
  calendarMismatch: boolean;
  imageUrl: string | null;
  xFollowers: number | null;
  social: SocialFact | null;
  creator: CreatorStats | null;
  quality: QualityResult;
  links: { opensea: string; explorer: string };
}

export function parseHistory(text: string): HistoryLine[] {
  const lines: HistoryLine[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed?.chain && parsed?.contract) lines.push(parsed as HistoryLine);
    } catch {
      // a torn last line is expected if the scanner is running
    }
  }
  return lines;
}

export function loadHistory(file: string): HistoryLine[] {
  try {
    return parseHistory(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}

const EMPTY_QUALITY: QualityResult = {
  score: null,
  confidence: 0,
  dimensions: { demand: null, participation: null, creator: null, social: null, structure: null },
  penalties: [],
};

// A collection we have read (even if it turned out to have no links) is a known
// fact and must be scored as such; one we have never read is unknown.
function socialFact(entry: ContractEntry): SocialFact | null {
  const known = entry.socialCheckedAt != null;
  const anyLink = entry.twitter != null || entry.discord != null || entry.website != null;
  if (!known && !anyLink) return null;
  return {
    twitter: entry.twitter ?? null,
    discord: entry.discord ?? null,
    website: entry.website ?? null,
    createdDate: entry.createdDate ?? null,
    safelist: entry.safelist ?? null,
  };
}

// Structural facts come from the state file; change and concentration labels are
// taken verbatim from the last audit (single source — the auditor already knows
// about scan coverage, so a partial scan cannot produce a misleading label).
function deriveNotes(input: {
  soldOut: boolean;
  pendingAudit: boolean;
  auditRisks: string[];
  calendarNotes?: string[];
}): string[] {
  const notes: string[] = [];
  if (input.soldOut) notes.push("sold out");
  if (input.pendingAudit) notes.push("queued (over limit)");
  for (const note of input.calendarNotes ?? []) {
    if (!notes.includes(note)) notes.push(note);
  }
  for (const risk of input.auditRisks) {
    if (!notes.includes(risk)) notes.push(risk);
  }
  return notes;
}

export function loadDashboardRows(
  state: ScanState,
  history: HistoryLine[],
  ledger: Ledger,
  cacheLoader: (chain: string, contract: string) => CachedScan | null = readCachedScan,
  backfills: BackfillRecord[] = []
): DashboardRow[] {
  const netsByTarget = new Map<string, Record<string, string>>();
  const latestBackfill = new Map<string, BackfillRecord>();
  for (const record of backfills) {
    const key = `${record.chain}|${record.contract.toLowerCase()}`;
    const nets = netsByTarget.get(key) ?? {};
    const net = formatNetUsd(record);
    if (net !== null) nets[String(record.checkpointHours)] = net;
    netsByTarget.set(key, nets);
    const current = latestBackfill.get(key);
    if (!current || record.checkpointHours >= current.checkpointHours) latestBackfill.set(key, record);
  }
  const byTarget = new Map<string, GradePoint[]>();
  for (const line of history) {
    const key = `${line.chain}|${line.contract.toLowerCase()}`;
    const points = byTarget.get(key) ?? [];
    points.push({
      at: line.at,
      grade: line.grade,
      remaining: line.remaining,
      projected: line.projected,
      start: line.start ?? null,
      risks: line.risks,
      minted: line.totalMinted ?? null,
      slug: line.slug ?? null,
      name: line.name ?? null,
      owner: line.owner ?? null,
      mintPriceWei: line.mintPriceWei ?? null,
      capPerWallet: line.capPerWallet ?? null,
      endTime: line.endTime ?? null,
      maxSupply: line.maxSupply ?? null,
      recent15m: line.recent15m ?? null,
      recent1h: line.recent1h ?? null,
      uniqueMinters: line.uniqueMinters ?? null,
      topMinterShare: line.topMinterShare ?? null,
      presaleStages: line.presaleStages ?? null,
      maxTxTokens: line.maxTxTokens ?? null,
      payerDiffers: line.payerDiffers ?? null,
      smartMinters: line.smartMinters ?? null,
    });
    byTarget.set(key, points);
  }

  const rows: DashboardRow[] = [];
  const nowSec = Math.floor(Date.now() / 1000);
  // Creator history needs every contract's facts before it can be attached, so
  // the loop collects the raw signals and a second pass scores each row.
  const facts: CreatorFact[] = [];
  const pending: { row: DashboardRow; signals: Omit<QualitySignals, "nowSec" | "creator"> }[] = [];
  for (const [chain, contracts] of Object.entries(state.contracts)) {
    for (const [contract, entry] of Object.entries(contracts)) {
      const key = `${chain}|${contract.toLowerCase()}`;
      const points = (byTarget.get(key) ?? []).sort((a, b) => a.at.localeCompare(b.at));
      const latest = points[points.length - 1];
      const cached = cacheLoader(chain, contract);

      const executionEntry = entryOf(ledger, chain, contract);
      const execution = executionEntry
        ? {
            status: executionEntry.status,
            txHash: executionEntry.txHash,
            at: executionEntry.at,
            quantity: executionEntry.quantity,
            mintedCount: executionEntry.mintedCount ?? null,
          }
        : null;
      const chainStart = entry.publicStart ?? latest?.start ?? null;
      const calendar = entry.calendar ?? null;
      // The last stage is the public sale; the first is usually a presale wave,
      // so the fallback and the reschedule check both use the public guess.
      const calendarPublicStart = calendar?.publicStartTime ?? calendar?.startTime ?? null;
      // Discovery snapshots can be hours older than a later audit; taking the
      // entry unconditionally is what kept a pre-flip price on screen.
      const mintPriceWei = freshest<string>([
        { value: entry.mintPriceWei, at: entry.factsAt },
        { value: latest?.mintPriceWei ?? null, at: latest?.at ?? null },
      ]);
      const capPerWallet = freshest<number>([
        { value: entry.capPerWallet, at: entry.factsAt },
        { value: latest?.capPerWallet ?? null, at: latest?.at ?? null },
      ]);
      const priceFlip = isPriceFlip(entry, { nowMs: nowSec * 1000 });
      const hasChainPlan = mintPriceWei !== null || capPerWallet !== null;
      const start = chainStart ?? calendarPublicStart;
      const endTime = entry.endTime ?? latest?.endTime ?? calendar?.endTime ?? null;
      // A start the project moved without updating the calendar (or vice versa).
      const calendarMismatch =
        calendarPublicStart != null && chainStart != null && Math.abs(chainStart - calendarPublicStart) > 60;
      const slug = entry.slug ?? latest?.slug ?? null;
      const name = entry.name ?? latest?.name ?? null;
      const owner = entry.owner ?? latest?.owner ?? null;
      const topShare = cached?.mintScan.topMinterShare ?? null;
      const maxTxTokens = latest?.maxTxTokens ?? (cached ? cached.mintScan.maxTxTokens?.toString() ?? null : null);
      // One transaction minting ten or more tokens is a clone-contract batch,
      // not a human (the winning wallet on The Obscura did 1,000 in one call).
      const batchMint = maxTxTokens !== null && BigInt(maxTxTokens) >= 10n;
      const smartMinters = latest?.smartMinters ?? null;

      const backfill = latestBackfill.get(key) ?? null;
      // Our own checkpoints are a summary, not per-sale samples, so they can
      // label liquidity but never produce a reference price on their own.
      const liquidity = liquidityVerdict(
        backfill
          ? { salesCount: backfill.salesCount, uniqueBuyers: backfill.uniqueBuyers, checkedAtMs: Date.parse(backfill.at) }
          : null,
        nowSec * 1000
      );
      const minted = entry.totalMinted != null ? BigInt(entry.totalMinted) : latest?.minted != null ? BigInt(latest.minted) : null;
      const maxSupply = entry.maxSupply != null ? BigInt(entry.maxSupply) : latest?.maxSupply != null ? BigInt(latest.maxSupply) : null;
      const remainingNow = latest?.remaining != null ? BigInt(latest.remaining) : null;
      const fallbackPerHour =
        latest?.recent1h != null
          ? BigInt(latest.recent1h)
          : latest?.recent15m != null
            ? BigInt(latest.recent15m) * 4n
            : null;
      const velocity = velocityPer24h(points, fallbackPerHour);
      const stale = staleVerdict({
        startSec: start,
        nowSec,
        minted,
        maxSupply,
        velocityPer24h: velocity.per24h,
      });
      const phase = classifyPhase({
        startSec: start,
        endSec: endTime,
        nowSec,
        minted,
        maxSupply,
        stale,
        soldOut: entry.soldOutAtBlock !== null,
      });
      // Keep the state for creator history, but stop rendering rows whose stage
      // closed more than a week ago.
      if (phase === 'ended' && endTime !== null && endTime + 7 * 86_400 < nowSec) continue;
      const explorer = resolveChain(chain)?.explorer ?? "";
      const social = socialFact(entry);
      // Share of the supply the presale stages absorbed (only known when an
      // audit cache exists); it is both a demand proxy and a sell-out warning.
      const presaleTokens = (cached?.mintScan.stages ?? [])
        .filter((stage) => stage.stage !== 0)
        .reduce((sum, stage) => sum + stage.tokens, 0n);
      const presaleShare =
        cached && maxSupply !== null && maxSupply > 0n ? Number((presaleTokens * 10_000n) / maxSupply) / 10_000 : null;
      const row: DashboardRow = {
        chain,
        contract,
        start,
        // A grade from history next to a row without a plan reads as a
        // judgement we cannot stand behind; only show it when there is a plan.
        grade: hasChainPlan ? entry.lastGrade ?? latest?.grade ?? null : null,
        gradeHistory: points,
        remaining: latest?.remaining ?? null,
        projected: latest?.projected ?? null,
        lastAuditedAt: entry.lastAuditedAt,
        pendingAudit: entry.pendingAudit,
        soldOut: entry.soldOutAtBlock !== null,
        execution,
        stages: (cached?.mintScan.stages ?? []).map((s) => ({
          stage: s.stage,
          tokens: s.tokens.toString(),
          minters: s.uniqueMinters,
        })),
        topMinterShare: topShare,
        nets: netsByTarget.get(key) ?? {},
        notes: deriveNotes({
          soldOut: entry.soldOutAtBlock !== null,
          pendingAudit: entry.pendingAudit,
          auditRisks: [...points].reverse().find((p) => p.risks && p.risks.length > 0)?.risks ?? [],
          calendarNotes: [
            calendar ? "calendar listed" : "",
            calendar?.isVerified === false ? "unverified on OpenSea" : "",
            calendar?.disabledReason ? `OpenSea disabled: ${calendar.disabledReason}` : "",
            calendarMismatch ? "schedule mismatch" : "",
          ].filter(Boolean),
        }),
        slug,
        name,
        owner,
        mintPriceWei,
        capPerWallet,
        endTime,
        maxSupply: maxSupply === null ? null : maxSupply.toString(),
        minted: minted === null ? null : minted.toString(),
        recent15m: latest?.recent15m ?? null,
        recent1h: latest?.recent1h ?? null,
        uniqueMinters: latest?.uniqueMinters ?? null,
        presaleStages: latest?.presaleStages ?? null,
        velocity24h: velocity.per24h === null ? null : velocity.per24h.toString(),
        velocitySource: velocity.source,
        sellOutEtaHours: sellOutEtaHours(remainingNow, velocity.per24h),
        stale,
        phase,
        presaleShare,
        batchMint,
        priceFlip,
        priceHistory: entry.priceHistory ?? [],
        liquidity: liquidity.level === "unknown" ? null : liquidity,
        maxTxTokens,
        payerDiffers: latest?.payerDiffers ?? null,
        smartMinters,
        calendar,
        calendarMismatch,
        imageUrl: safeImageUrl(entry.imageUrl),
        xFollowers: entry.xFollowers ?? null,
        social,
        creator: null,
        quality: EMPTY_QUALITY,
        links: {
          opensea: slug ? `https://opensea.io/collection/${slug}` : "",
          explorer: explorer ? `${explorer}/address/${contract}` : "",
        },
      };
      rows.push(row);
      facts.push({ owner: owner ?? "", chain, contract, soldOut: row.soldOut, maxSupply, minted, velocity24h: velocity.per24h });
      pending.push({
        row,
        signals: {
          phase,
          stale,
          mintPriceWei: row.mintPriceWei,
          startSec: start,
          endSec: endTime,
          maxSupply,
          minted,
          remaining: remainingNow,
          velocity24h: velocity.per24h,
          uniqueMinters: row.uniqueMinters,
          topMinterShare: row.topMinterShare,
          presaleStages: row.presaleStages,
          presaleShare,
          capPerWallet: row.capPerWallet,
          batchMint,
          priceFlip,
          smartMinters,
          social,
        },
      });
    }
  }

  // A target must not score on its own success, so its creator history is
  // aggregated with the target itself excluded (dropCount 0 then means unknown).
  for (const { row, signals } of pending) {
    const creatorKey = (row.owner ?? "").trim().toLowerCase();
    row.creator = creatorKey
      ? creatorStatsFor(creatorKey, facts, backfills, ledger, { chain: row.chain, contract: row.contract })
      : null;
    row.quality = qualityScore({ ...signals, nowSec, creator: row.creator });
  }

  rows.sort((a, b) => (a.start ?? Number.MAX_SAFE_INTEGER) - (b.start ?? Number.MAX_SAFE_INTEGER));
  return rows;
}

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  if (days > 0) return `${days}d`;
  if (hours > 0) return `${hours}h${minutes ? ` ${minutes}m` : ""}`;
  if (minutes > 0) return `${minutes}m`;
  return `${total}s`;
}

export function describeWindow(startSec: number | null, endTimeSec: number | null): string {
  if (startSec === null) return "";
  const now = Math.floor(Date.now() / 1000);
  if (startSec > now) return `opens in ${formatDuration(startSec - now)}`;
  const opened = formatDuration(now - startSec);
  if (endTimeSec === null) return `opened ${opened} ago`;
  if (endTimeSec <= now) return `ended ${formatDuration(now - endTimeSec)} ago`;
  return `opened ${opened} ago · ends in ${formatDuration(endTimeSec - now)}`;
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// 24h velocity comes from the audit series (ΔtotalMinted / Δt) because the log
// scan only looks back half a day. When the series is too short — a target that
// just opened — the 1h log bucket is scaled up and labelled as an estimate.
export function velocityPer24h(
  points: { at: string; minted?: string | null }[],
  fallbackPerHour: bigint | null
): { per24h: bigint | null; source: "differential" | "bucket" | null } {
  const series = points
    .map((point) => ({
      atMs: Date.parse(point.at),
      minted: point.minted === null || point.minted === undefined ? null : BigInt(point.minted),
    }))
    .filter((point): point is { atMs: number; minted: bigint } => point.minted !== null && Number.isFinite(point.atMs))
    .sort((a, b) => a.atMs - b.atMs);

  const latest = series[series.length - 1];
  if (latest) {
    const target = latest.atMs - 24 * 3_600_000;
    let best: { atMs: number; minted: bigint } | null = null;
    for (const point of series) {
      if (point.atMs >= latest.atMs) continue;
      if (best === null || Math.abs(point.atMs - target) < Math.abs(best.atMs - target)) best = point;
    }
    if (best) {
      const hours = (latest.atMs - best.atMs) / 3_600_000;
      const delta = latest.minted - best.minted;
      if (hours >= 6 && delta >= 0n) {
        return { per24h: (delta * 24n) / BigInt(Math.round(hours)), source: "differential" };
      }
    }
  }
  if (fallbackPerHour !== null) return { per24h: fallbackPerHour * 24n, source: "bucket" };
  return { per24h: null, source: null };
}

// "Opened a day ago, barely minted, nobody is coming": useful to hide by
// default, but never silently — the UI shows how many rows it filtered.
export function staleVerdict(input: {
  startSec: number | null;
  nowSec: number;
  minted: bigint | null;
  maxSupply: bigint | null;
  velocityPer24h: bigint | null;
}): boolean {
  const { startSec, nowSec, minted, maxSupply } = input;
  if (startSec === null || minted === null || maxSupply === null || maxSupply === 0n) return false;
  if (nowSec - startSec < 24 * 3_600) return false;
  const mintedBps = Number((minted * 10_000n) / maxSupply); // basis points
  if (mintedBps >= 1_000) return false; // 10%
  const quietFloor = maxSupply / 1_000n > 5n ? maxSupply / 1_000n : 5n; // max(5, 0.1% of supply)
  return (input.velocityPer24h ?? 0n) < quietFloor;
}

// One definition of the target's lifecycle, shared by the table, the filters and
// the default preset. Missing facts mean 'unaudited', never 'fine'.
export function classifyPhase(input: {
  startSec: number | null;
  endSec: number | null;
  nowSec: number;
  minted: bigint | null;
  maxSupply: bigint | null;
  stale: boolean;
  soldOut: boolean;
}): Phase {
  const { startSec, endSec, nowSec, minted, maxSupply, stale, soldOut } = input;
  if (startSec === null) return 'unaudited';
  // A calendar-only target has no chain facts yet; a future start still makes it
  // upcoming (that is the point of the calendar), anything else stays unknown.
  if (minted === null || maxSupply === null) return startSec > nowSec ? 'upcoming' : 'unaudited';
  if (soldOut || (maxSupply > 0n && minted >= maxSupply)) return 'sold-out';
  if (endSec !== null && endSec <= nowSec) return 'ended';
  if (startSec > nowSec) return 'upcoming';
  if (nowSec - startSec <= 24 * 3_600) return 'live-fresh';
  if (stale) return 'stale';
  return 'live';
}

export function sellOutEtaHours(remaining: bigint | null, velocityPer24h: bigint | null): number | null {
  if (remaining === null || velocityPer24h === null || velocityPer24h <= 0n || remaining < 0n) return null;
  const hours = Number((remaining * 24n) / velocityPer24h);
  return Number.isFinite(hours) ? hours : null;
}

export interface DashboardMeta {
  generatedAt: string;
  sources: string[];
}

// Chinese labels for the display layer only; identifiers (name, slug, contract,
// chain key, tx hash) and the CLI stay in English as the repo convention.
const PHASE_ZH: Record<Phase, string> = {
  upcoming: "未开售",
  "live-fresh": "新开售",
  live: "在售",
  stale: "陈旧",
  "sold-out": "售罄",
  ended: "已结束",
  unaudited: "待复审",
};

const PHASE_ORDER: Phase[] = ["upcoming", "live-fresh", "live", "stale", "sold-out", "ended", "unaudited"];
const CORE_COLUMNS = 14;

const DIMENSION_ZH: [QualityDimension, string][] = [
  ["demand", "需求"],
  ["participation", "参与"],
  ["creator", "创作者"],
  ["social", "社交"],
  ["structure", "结构"],
];

const PENALTY_ZH: Record<Penalty, string> = {
  stale: "陈旧",
  concentrated: "集中度高",
  "no-socials": "无社交",
  "instant-sellout": "预计秒空",
  "batch-mint": "批量痕迹",
  "price-flip": "改价",
};

function netClass(net: string | null | undefined): string {
  if (!net) return "";
  const value = Number(net.replace(/[^0-9.-]/g, ""));
  if (!Number.isFinite(value) || value === 0) return "";
  return value > 0 ? "net-pos" : "net-neg";
}

function mintedBar(pct: number | null): string {
  if (pct === null) return "";
  const width = Math.min(100, Math.max(0, pct)).toFixed(1);
  return `<div class="bar"><span style="width:${width}%"></span></div>`;
}

export function renderDashboard(
  rows: DashboardRow[],
  meta: DashboardMeta,
  opts: {
    serve?: boolean;
    favorites?: FavoritesStore;
    queue?: {
      jobs: QueueJob[];
      armed: { armed: boolean; expiresAtMs?: number };
      heartbeat: { at?: string; host?: string } | null;
    };
  } = {}
): string {
  const favorites = opts.favorites ?? emptyFavorites();
  const favoriteRows = new Set(rows.map((row) => favoriteKey(row.chain, row.contract)));
  const missingFavorites = Object.entries(favorites.favorites).filter(([key]) => !favoriteRows.has(key));
  const explorerTx = (chain: string, hash: string | null): string | null => {
    if (!hash) return null;
    const explorer = resolveChain(chain)?.explorer;
    return explorer ? `${explorer}/tx/${hash}` : null;
  };

  // ── summary ──────────────────────────────────────────────────────────
  const byPhase = new Map<Phase, number>();
  for (const row of rows) byPhase.set(row.phase, (byPhase.get(row.phase) ?? 0) + 1);
  const freeCount = rows.filter((row) => row.mintPriceWei === "0").length;
  const queuedCount = rows.filter((row) => row.pendingAudit).length;
  const nextOpen = rows
    .filter((row) => row.phase === "upcoming" && row.start !== null)
    .sort((a, b) => (a.start ?? 0) - (b.start ?? 0))[0];

  const cards = [
    ...PHASE_ORDER.filter((phase) => (byPhase.get(phase) ?? 0) > 0).map(
      (phase) => `<div class="card"><span class="card-num">${byPhase.get(phase)}</span><span class="card-label">${PHASE_ZH[phase]}</span></div>`
    ),
    `<div class="card"><span class="card-num">${freeCount}</span><span class="card-label">免费</span></div>`,
    `<div class="card"><span class="card-num">${queuedCount}</span><span class="card-label">队列中</span></div>`,
  ].join("");
  const nextOpenText = nextOpen
    ? `${escapeHtml(nextOpen.name ?? nextOpen.contract.slice(0, 10) + "…")} · ${escapeHtml(describeWindow(nextOpen.start, nextOpen.endTime))}`
    : "—";

  // ── rows ─────────────────────────────────────────────────────────────
  const rowHtml = rows
    .map((row) => {
      const startText = row.start === null ? "" : toUtc8Time(new Date(row.start * 1000));
      const window = describeWindow(row.start, row.endTime);
      const price = row.mintPriceWei === null ? null : BigInt(row.mintPriceWei);
      const flipPill = row.priceFlip
        ? ` <span class="pill instant" title="公开阶段价格在上线后被改过（免费→收费或开售前后改价），当前值来自最新一次链上读取">改价</span>`
        : "";
      const priceText =
        price === null ? "—" : `${price === 0n ? `<span class="pill free">免费</span>` : formatEther(price)}${flipPill}`;
      const capText = row.capPerWallet === null ? "—" : row.capPerWallet === 0 ? "不限" : String(row.capPerWallet);
      const mintedPct =
        row.minted !== null && row.maxSupply !== null && BigInt(row.maxSupply) > 0n
          ? Number((BigInt(row.minted) * 10_000n) / BigInt(row.maxSupply)) / 100
          : null;
      const etaText =
        row.sellOutEtaHours === null
          ? ""
          : row.sellOutEtaHours < 1
            ? "<1时"
            : row.sellOutEtaHours < 48
              ? `${Math.round(row.sellOutEtaHours)}时`
              : `${(row.sellOutEtaHours / 24).toFixed(1)}天`;
      const hot = row.velocity24h !== null && BigInt(row.velocity24h) > 0n;
      const txUrl = explorerTx(row.chain, row.execution?.txHash ?? null);
      const gradeCell =
        row.phase === "unaudited"
          ? `<span class="pill g-?">?</span>`
          : `<span class="pill g-${escapeHtml(row.grade ?? "?")}">${escapeHtml(row.grade ?? "?")}</span>`;
      const thumb = row.imageUrl ? `<img class="thumb" src="${escapeHtml(row.imageUrl)}" alt="" loading="lazy">` : "";
      const quality = row.quality ?? EMPTY_QUALITY;
      const qScore = quality.score;
      const instant = quality.penalties.includes("instant-sellout");
      const instantPill = instant
        ? ` <span class="pill instant" title="预售已吃掉大部分供应、地址多且每钱包至少 5 个，公售剩余大概率被批量合约秒光">预计秒空</span>`
        : "";
      const batchPill = row.batchMint
        ? ` <span class="pill instant" title="单笔交易铸出大量 token（疑克隆合约批量铸造），单钱包大概率抢不到">批量痕迹</span>`
        : "";
      const calendarBadges = [
        row.calendar ? `<span class="pill cal" title="来自 OpenSea drops 日历（提前量来源）">日历</span>` : "",
        row.calendar?.isVerified === false ? `<span class="pill unverified" title="OpenSea 未认证">未认证</span>` : "",
        row.calendar?.disabledReason
          ? `<span class="pill disabled" title="OpenSea 标记：${escapeHtml(row.calendar.disabledReason)}">平台禁用</span>`
          : "",
      ]
        .filter(Boolean)
        .join(" ");
      const qCell =
        qScore === null
          ? `<span class="pill q-none" title="数据不足，不足以评分">—</span>`
          : `<span class="pill ${qScore >= 70 ? "q-strong" : qScore >= 45 ? "q-mid" : "q-weak"}">${qScore}</span> <span class="muted">${Math.round(
              quality.confidence * 100
            )}%</span>`;

      const favorite = favorites.favorites[favoriteKey(row.chain, row.contract)] ?? null;
      // The snapshot is what the user saw when starring the target: the whole
      // point is to compare those signals with the outcome later.
      const snapshot = JSON.stringify({
        at: new Date().toISOString(),
        grade: row.grade,
        q: qScore,
        confidence: quality.confidence,
        phase: row.phase,
        start: row.start,
        mintPriceWei: row.mintPriceWei,
        remaining: row.remaining,
        maxSupply: row.maxSupply,
        minted: row.minted,
        velocity24h: row.velocity24h,
        uniqueMinters: row.uniqueMinters,
        topMinterShare: row.topMinterShare,
        smartMinters: row.smartMinters,
        batchMint: row.batchMint,
        penalties: quality.penalties,
        calendarListed: row.calendar !== null,
        creatorDropCount: row.creator?.dropCount ?? null,
      });
      const data = [
        `data-chain="${escapeHtml(row.chain)}"`,
        `data-contract="${escapeHtml(row.contract)}"`,
        `data-favorite="${favorite ? "1" : "0"}"`,
        `data-slug="${escapeHtml(row.slug ?? "")}"`,
        `data-name="${escapeHtml(row.name ?? "")}"`,
        `data-snapshot="${escapeHtml(snapshot)}"`,
        `data-grade="${escapeHtml(row.grade ?? "")}"`,
        `data-q="${qScore === null ? "" : qScore}"`,
        `data-instant="${instant ? "1" : "0"}"`,
        `data-phase="${escapeHtml(row.phase)}"`,
        `data-start="${row.start ?? ""}"`,
        `data-pending="${row.pendingAudit ? "1" : "0"}"`,
        `data-executed="${row.execution ? "1" : "0"}"`,
        `data-stale="${row.stale ? "1" : "0"}"`,
        // "only free" must not offer a target whose free price was bait.
        `data-free="${price === null ? "" : price === 0n && !row.priceFlip ? "1" : "0"}"`,
        `data-flip="${row.priceFlip ? "1" : "0"}"`,
        `data-mintprice="${escapeHtml(row.mintPriceWei ?? "")}"`,
        `data-mintedpct="${mintedPct === null ? "" : mintedPct}"`,
        `data-remaining="${escapeHtml(row.remaining ?? "")}"`,
        `data-recent1h="${escapeHtml(row.recent1h ?? "")}"`,
        `data-minters="${row.uniqueMinters ?? ""}"`,
        `data-velocity="${escapeHtml(row.velocity24h ?? "")}"`,
        `data-notes="${escapeHtml(row.notes.join("；"))}"`,
        `data-risks="${escapeHtml(quality.penalties.join(","))}"`,
        `data-net24usd="${escapeHtml(row.nets["24"] ?? "")}"`,
        `data-net72usd="${escapeHtml(row.nets["72"] ?? "")}"`,
        `data-target="${escapeHtml(`${row.name ?? ""} ${row.contract} ${row.chain}`)}"`,
      ].join(" ");

      const links = [
        row.links.opensea
          ? `<a href="${escapeHtml(row.links.opensea)}" target="_blank" rel="noreferrer">OpenSea</a>`
          : `<span class="muted" title="运行 --refresh-targets 解析 slug">slug?</span>`,
        row.links.explorer ? `<a href="${escapeHtml(row.links.explorer)}" target="_blank" rel="noreferrer">浏览器</a>` : "",
      ]
        .filter(Boolean)
        .join(" · ");

      const liquidityLine = row.liquidity
        ? `<span>流动性：${escapeHtml(row.liquidity.label)}${
            row.phase === "upcoming" ? "（未开售，暂无二级成交）" : ""
          }${row.calendar?.floorValue != null && row.phase !== "upcoming" ? ` · 挂单地板 ${escapeHtml(String(row.calendar.floorValue))} ${escapeHtml(row.calendar.floorSymbol ?? "")}` : ""}</span>`
        : "";
      const batchLine = row.maxTxTokens
        ? `<span>铸造结构：单笔最多 ${escapeHtml(row.maxTxTokens)} 个${
            row.payerDiffers ? ` · 付款人≠铸造人 ${row.payerDiffers} 笔` : ""
          }${row.smartMinters != null ? ` · 聪明铸造者触达 ${row.smartMinters}` : ""}</span>`
        : row.smartMinters != null
          ? `<span>聪明铸造者触达 ${row.smartMinters}</span>`
          : "";
      // Rows injected by tests or an older scheduler may omit the field.
      const priceHistory = row.priceHistory ?? [];
      const priceHistoryLine =
        priceHistory.length > 0
          ? `<span>公开阶段价格变更：${priceHistory
              .slice(0, 5)
              .map((point) => `${point.priceWei === "0" ? "免费" : point.priceWei}（cap ${point.cap ?? "不限"}）@${point.at.slice(5, 16)}`)
              .join(" → ")}</span>`
          : "";
      const calendarLine = row.calendar
        ? `<span>日历：收录 ${escapeHtml(row.calendar.listedAt.slice(0, 16).replace("T", " "))}Z${
            row.calendar.startTime ? ` · 开售 ${escapeHtml(toUtc8Time(new Date(row.calendar.startTime * 1000)))}` : ""
          }${
            row.calendar.publicStartTime != null && row.calendar.startTime != null && row.calendar.publicStartTime !== row.calendar.startTime
              ? "（最早为预售阶段）"
              : ""
          }${
            row.calendar.floorValue != null
              ? ` · 地板 ${escapeHtml(String(row.calendar.floorValue))} ${escapeHtml(row.calendar.floorSymbol ?? "")}${
                  row.calendar.floorUsd != null ? `（≈${row.calendar.floorUsd.toFixed(2)}）` : ""
                }`
              : ""
          }${row.calendar.topOfferValue != null ? ` · 最高报价 ${escapeHtml(String(row.calendar.topOfferValue))}` : ""}${
            row.calendar.maxSupply ? ` · 供应 ${escapeHtml(row.calendar.totalSupply ?? "?")}/${escapeHtml(row.calendar.maxSupply)}` : ""
          }${row.calendar.stages.length > 0 ? ` · 阶段 ${row.calendar.stages.length}` : ""}</span>`
        : "";
      const mismatchLine = row.calendarMismatch
        ? `<span class="warn-text">日程不一致：链上与日历的开售时间相差超过 1 分钟（项目方可能改期）</span>`
        : "";

      const socialBits: string[] = [];
      if (row.social) {
        const xUrl = safeLinkUrl(row.social.twitter ? `https://x.com/${row.social.twitter.replace(/^@/, "")}` : null);
        if (xUrl) socialBits.push(`<a href="${escapeHtml(xUrl)}" target="_blank" rel="noreferrer">X</a>`);
        const discord = safeLinkUrl(row.social.discord);
        if (discord) socialBits.push(`<a href="${escapeHtml(discord)}" target="_blank" rel="noreferrer">Discord</a>`);
        const website = safeLinkUrl(row.social.website);
        if (website) socialBits.push(`<a href="${escapeHtml(website)}" target="_blank" rel="noreferrer">官网</a>`);
        if (row.xFollowers != null) socialBits.push(`${row.xFollowers} 粉丝`);
        if (row.social.safelist) socialBits.push(`清单：${escapeHtml(row.social.safelist)}`);
        if (row.social.createdDate) socialBits.push(`创建：${escapeHtml(row.social.createdDate.slice(0, 10))}`);
      }
      const creatorText = row.creator
        ? `创作者：${row.creator.dropCount} 个 drop · 售罄率 ${
            row.creator.soldOutRate === null ? "—" : `${Math.round(row.creator.soldOutRate * 100)}%`
          } · 平均速度 ${row.creator.avgVelocity24h ?? "—"}/天 · 二级成交 ${row.creator.salesCount ?? "—"} · 自有 mint ${
            row.creator.ownMints
          }${row.creator.ownNetUsd === null ? "" : ` · 净值 $${row.creator.ownNetUsd.toFixed(2)}`}${
            row.creator.ownData ? "（自有数据）" : ""
          }`
        : "";
      const qBreakdown =
        qScore === null
          ? ""
          : `Q 拆分：${DIMENSION_ZH.map(([key, label]) => `${label} ${quality.dimensions[key] ?? "—"}`).join(" · ")}`;

      const detailBits = [
        row.stages.length > 0
          ? `<span>阶段拆分：${row.stages.map((s) => `#${s.stage} ${s.tokens}（${s.minters} 地址）`).join(" &nbsp;|&nbsp; ")}</span>`
          : "",
        row.presaleStages !== null && row.presaleStages > 0 ? `<span>预售阶段：${row.presaleStages}</span>` : "",
        calendarLine,
        mismatchLine,
        priceHistoryLine,
        batchLine,
        liquidityLine,
        `<span class="fav-editor"></span>`,
        `<span class="enqueue-row"><button type="button" class="enqueue" data-chain="${escapeHtml(row.chain)}" data-contract="${escapeHtml(row.contract)}" data-slug="${escapeHtml(row.slug ?? "")}" data-name="${escapeHtml(row.name ?? "")}" data-start="${row.start ?? ""}">加入执行队列</button></span>`,
        socialBits.length > 0 ? `<span>社交：${socialBits.join(" · ")}</span>` : "",
        row.creator ? `<span>${creatorText}</span>` : "",
        qBreakdown ? `<span>${qBreakdown}</span>` : "",
        quality.penalties.length > 0
          ? `<span>扣分项：${quality.penalties.map((penalty) => PENALTY_ZH[penalty]).join("、")}</span>`
          : "",
        row.notes.length > 0 ? `<span>备注：${escapeHtml(row.notes.join("；"))}</span>` : "",
        row.slug ? `<span>slug：<span class="mono">${escapeHtml(row.slug)}</span></span>` : "",
        row.owner ? `<span>owner：<span class="mono">${escapeHtml(row.owner)}</span></span>` : "",
        row.execution
          ? `<span>执行：${escapeHtml(row.execution.status)}${
              row.execution.mintedCount !== null ? ` ×${row.execution.mintedCount}` : ""
            }${txUrl ? ` <a href="${escapeHtml(txUrl)}" target="_blank" rel="noreferrer">tx</a>` : ""}</span>`
          : "",
        row.nets["24"] ? `<span>24时净值：<span class="${netClass(row.nets["24"])}">${escapeHtml(row.nets["24"])}</span></span>` : "",
        row.nets["72"] ? `<span>72时净值：<span class="${netClass(row.nets["72"])}">${escapeHtml(row.nets["72"])}</span></span>` : "",
        `<span>等级轨迹：${escapeHtml(row.gradeHistory.map((p) => `${p.grade}@${p.at.slice(5, 16)}`).join(" → ") || "—")}</span>`,
      ]
        .filter(Boolean)
        .join("");

      return `<tr ${data} class="main-row">
  <td class="col-check"><input type="checkbox" class="pick" value="${escapeHtml(row.contract)}" data-chain="${escapeHtml(row.chain)}"></td>
  <td class="col-name">${thumb}<span class="caret">▸</span><span class="name-main">${escapeHtml(row.name ?? "—")}</span>${instantPill}${batchPill}${calendarBadges ? " " + calendarBadges : ""}<div class="mono muted">${escapeHtml(row.contract)}</div></td>
  <td>${gradeCell}</td>
  <td class="num">${qCell}</td>
  <td><span class="pill phase phase-${escapeHtml(row.phase)}">${PHASE_ZH[row.phase]}</span></td>
  <td>${startText ? escapeHtml(startText) : "—"}<div class="muted">${escapeHtml(window)}</div></td>
  <td class="num">${priceText}</td>
  <td class="num">${escapeHtml(capText)}</td>
  <td class="num">${row.minted ?? "—"}${mintedPct === null ? "" : ` <span class="muted">(${mintedPct.toFixed(1)}%)</span>`}${mintedBar(mintedPct)}</td>
  <td class="num">${escapeHtml(row.remaining ?? "—")}</td>
  <td class="num">${escapeHtml(row.recent15m ?? "—")} / ${escapeHtml(row.recent1h ?? "—")}</td>
  <td class="num">${row.uniqueMinters ?? "—"}${row.topMinterShare === null ? "" : ` <span class="muted">top ${Math.round(row.topMinterShare * 100)}%</span>`}</td>
  <td class="num ${hot ? "hot" : "cold"}">${escapeHtml(row.velocity24h ?? "—")}${row.velocitySource === "bucket" ? ` <span class="muted">1时估</span>` : ""}${etaText ? ` <span class="muted">→ ${escapeHtml(etaText)}</span>` : ""}</td>
  <td>${links}</td>
</tr>
<tr class="detail" hidden><td colspan="${CORE_COLUMNS}"><div class="detail-grid">${detailBits}</div></td></tr>`;
    })
    .join("\n");

  const serveBar = opts.serve
    ? `<div class="status" id="statusBar">
  <span class="state" id="stState">启动中…</span>
  <button id="scanNow">立即扫描</button>
  <span class="muted" id="stLog"></span>
</div>`
    : "";
  const serveScript = opts.serve
    ? `<script>
(function () {
  if (!document.getElementById("statusBar")) return;
  var state = document.getElementById("stState");
  var log = document.getElementById("stLog");
  var button = document.getElementById("scanNow");
  var builtForScan = null;
  function refresh() {
    fetch("/api/status", { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (s) {
      // Browsers pause <meta refresh> in background tabs, so the page itself
      // must notice that a newer scan finished while it was hidden.
      if (builtForScan === null) builtForScan = s.lastScanAt || "none";
      else if ((s.lastScanAt || "none") !== builtForScan) { location.reload(); return; }
      var parts = [s.running ? "扫描中…" : "空闲"];
      if (s.lastScanAt) parts.push("上次 " + s.lastScanAt.slice(11, 16) + "Z");
      if (s.nextScanAt) parts.push("下次 " + s.nextScanAt.slice(11, 16) + "Z");
      parts.push((s.rowCount || 0) + " 行");
      parts.push("OpenSea key: " + (s.openseaKey === "set" ? "已设置" : "未设置"));
      if (s.lastError) parts.push("错误：" + s.lastError);
      state.textContent = parts.join(" · ");
      if (s.log && s.log.length) { var last = s.log[s.log.length - 1]; log.textContent = last.slice(11, 19) + " " + last.slice(30); }
    }).catch(function () { state.textContent = "状态不可用"; });
  }
  button.addEventListener("click", function () {
    button.disabled = true;
    fetch("/api/scan", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || String(r.status)); return j; }); })
      .catch(function (e) { alert("扫描失败：" + e.message); })
      .then(function () { button.disabled = false; refresh(); });
  });
  refresh();
  setInterval(refresh, 15000);
})();
</script>`
    : "";

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="300">
<meta name="theme-color" content="#0f1115" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<title>SeaDrop 目标看板</title>
<style>
  :root {
    --bg: #ffffff; --bg-soft: #f6f7f9; --bg-hover: #eef2f7; --bg-elev: #ffffff;
    --fg: #16181d; --fg-soft: #4b5563; --fg-muted: #8a94a3;
    --outline: #e5e7eb; --outline-soft: #eef0f3;
    --primary: #2563eb; --on-primary: #ffffff;
    --ok: #15803d; --ok-soft: #dcfce7; --warn: #b45309; --warn-soft: #fef3c7;
    --danger: #b91c1c; --danger-soft: #fee2e2; --info: #6d28d9; --info-soft: #ede9fe;
    --teal: #0f766e; --teal-soft: #ccfbf1;
    --radius: 10px; --radius-sm: 6px;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f1115; --bg-soft: #151821; --bg-hover: #1b2030; --bg-elev: #151821;
      --fg: #e6e8ee; --fg-soft: #a8b0bf; --fg-muted: #6b7688;
      --outline: #252a36; --outline-soft: #1d2230;
      --primary: #60a5fa; --on-primary: #0b1220;
      --ok: #4ade80; --ok-soft: #14351f; --warn: #fbbf24; --warn-soft: #3a2c0a;
      --danger: #f87171; --danger-soft: #3d1416; --info: #c4b5fd; --info-soft: #2a1e4a;
      --teal: #5eead4; --teal-soft: #0f2e2b;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 18px 20px 40px; background: var(--bg); color: var(--fg);
    font: 13px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "PingFang SC", "Microsoft YaHei", sans-serif;
  }
  h1 { font-size: 17px; margin: 0 0 2px; letter-spacing: .2px; }
  .meta { color: var(--fg-muted); margin-bottom: 14px; font-size: 12px; }
  .cards { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
  .card {
    display: flex; flex-direction: column; min-width: 74px; padding: 8px 12px;
    background: var(--bg-soft); border: 1px solid var(--outline-soft); border-radius: var(--radius);
  }
  .card-num { font-size: 18px; font-weight: 650; font-variant-numeric: tabular-nums; }
  .card-label { font-size: 11px; color: var(--fg-muted); }
  .next-open { font-size: 12px; color: var(--fg-soft); margin-bottom: 12px; }
  .controls {
    display: flex; flex-wrap: wrap; gap: 10px 14px; align-items: center;
    padding: 10px 12px; margin-bottom: 12px;
    background: var(--bg-soft); border: 1px solid var(--outline-soft); border-radius: var(--radius);
  }
  .controls label { display: inline-flex; gap: 5px; align-items: center; color: var(--fg-soft); font-size: 12px; }
  select, input[type="search"], button {
    font: inherit; color: var(--fg); background: var(--bg-elev);
    border: 1px solid var(--outline); border-radius: var(--radius-sm); padding: 4px 8px;
  }
  button { cursor: pointer; }
  button:hover { border-color: var(--primary); color: var(--primary); }
  button.primary { background: var(--primary); border-color: var(--primary); color: var(--on-primary); font-weight: 600; }
  .status {
    display: flex; gap: 12px; align-items: center; flex-wrap: wrap;
    padding: 8px 12px; margin-bottom: 12px;
    background: var(--bg-soft); border: 1px solid var(--outline-soft); border-radius: var(--radius); font-size: 12px;
  }
  .status .state { font-weight: 600; }
  .table-wrap { overflow: auto; max-height: 76vh; border: 1px solid var(--outline-soft); border-radius: var(--radius); }
  table { border-collapse: separate; border-spacing: 0; width: 100%; min-width: 1180px; }
  th, td { padding: 6px 9px; text-align: left; border-bottom: 1px solid var(--outline-soft); vertical-align: top; }
  thead th {
    position: sticky; top: 0; z-index: 2; background: var(--bg-soft); color: var(--fg-soft);
    font-size: 11px; font-weight: 650; white-space: nowrap; cursor: pointer; user-select: none;
    border-bottom: 1px solid var(--outline);
  }
  tbody tr.main-row { background: var(--bg); }
  tbody tr.main-row:nth-of-type(4n+3) { background: var(--bg-soft); }
  tbody tr.main-row:hover { background: var(--bg-hover); }
  tbody tr.main-row { cursor: pointer; }
  td.col-check, th.col-check { position: sticky; left: 0; z-index: 1; width: 30px; background: inherit; }
  thead th.col-check { z-index: 3; }
  td.col-name, th.col-name { position: sticky; left: 30px; z-index: 1; min-width: 190px; background: inherit; }
  thead th.col-check, thead th.col-name { background: var(--bg-soft); z-index: 3; }
  .name-main { font-weight: 600; margin-left: 4px; }
  .caret { display: inline-block; width: 10px; color: var(--fg-muted); transition: transform .12s ease; }
  tr.main-row.open .caret { transform: rotate(90deg); }
  tr.detail > td { background: var(--bg-soft); }
  .detail-grid { display: grid; gap: 4px 18px; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); font-size: 12px; color: var(--fg-soft); }
  .muted { color: var(--fg-muted); font-size: 11px; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  th.num { text-align: right; }
  .hot { color: var(--ok); font-weight: 600; }
  .cold { color: var(--fg-muted); }
  .net-pos { color: var(--ok); font-weight: 600; }
  .net-neg { color: var(--danger); font-weight: 600; }
  .pill {
    display: inline-block; min-width: 18px; padding: 1px 7px; border-radius: 999px;
    font-size: 11px; font-weight: 650; text-align: center; border: 1px solid transparent;
  }
  .pill.free { background: var(--ok-soft); color: var(--ok); border-color: var(--ok-soft); }
  .thumb {
    width: 26px; height: 26px; border-radius: var(--radius-sm); object-fit: cover; vertical-align: middle;
    margin-right: 6px; border: 1px solid var(--outline-soft); background: var(--bg-soft);
  }
  .q-strong { background: var(--ok-soft); color: var(--ok); }
  .q-mid { background: var(--warn-soft); color: var(--warn); }
  .q-weak { background: var(--danger-soft); color: var(--danger); }
  .q-none { background: var(--outline-soft); color: var(--fg-muted); }
  .pill.instant { background: var(--danger-soft); color: var(--danger); border-color: var(--danger-soft); }
  .pill.cal { background: var(--info-soft); color: var(--info); }
  .pill.unverified { background: var(--warn-soft); color: var(--warn); }
  .pill.disabled { background: var(--danger-soft); color: var(--danger); }
  .warn-text { color: var(--warn); }
  .tabs { display: flex; gap: 8px; align-items: center; margin: 0 0 10px; }
  .tabs button.on { background: var(--primary); border-color: var(--primary); color: var(--on-primary); font-weight: 600; }
  .star { background: none; border: 0; padding: 0 4px 0 0; font-size: 15px; line-height: 1; color: var(--fg-muted); cursor: pointer; }
  .star.on { color: var(--warn); }
  tr.main-row.tab-hidden { display: none !important; }
  .missing { margin: 0 0 12px; padding: 10px 12px; border: 1px solid var(--outline-soft); border-radius: var(--radius); background: var(--bg-soft); }
  .missing-item { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; padding: 3px 0; }
  .fav-editor { display: inline-flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .queue-panel { margin: 0 0 12px; padding: 10px 12px; border: 1px solid var(--outline-soft); border-radius: var(--radius); background: var(--bg-soft); }
  .queue-head { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 8px; }
  .queue-job { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; padding: 4px 0; border-top: 1px solid var(--outline-soft); }
  .queue-status { min-width: 72px; font-weight: 600; }
  .queue-job.status-done .queue-status { color: var(--ok); }
  .queue-job.status-failed .queue-status { color: var(--danger); }
  .queue-job.status-cancelled .queue-status, .queue-job.status-skipped .queue-status { color: var(--fg-muted); }
  .g-A { background: var(--ok-soft); color: var(--ok); }
  .g-B { background: var(--warn-soft); color: var(--warn); }
  .g-C { background: var(--danger-soft); color: var(--danger); }
  .g-D { background: var(--info-soft); color: var(--info); }
  .g-\? { background: var(--outline-soft); color: var(--fg-muted); }
  .phase-upcoming { background: var(--info-soft); color: var(--info); }
  .phase-live-fresh { background: var(--ok-soft); color: var(--ok); }
  .phase-live { background: var(--teal-soft); color: var(--teal); }
  .phase-stale { background: var(--outline-soft); color: var(--fg-muted); }
  .phase-sold-out { background: var(--danger-soft); color: var(--danger); }
  .phase-ended { background: var(--outline-soft); color: var(--fg-muted); }
  .phase-unaudited { background: var(--warn-soft); color: var(--warn); }
  .bar { height: 4px; margin-top: 4px; background: var(--outline-soft); border-radius: 999px; overflow: hidden; min-width: 70px; }
  .bar > span { display: block; height: 100%; background: var(--primary); }
  .out { margin-top: 16px; }
  textarea { width: 100%; min-height: 80px; padding: 8px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--fg); background: var(--bg-elev); border: 1px solid var(--outline); border-radius: var(--radius-sm); }
  pre { white-space: pre-wrap; margin: 6px 0 0; }
  a { color: var(--primary); text-decoration: none; }
  a:hover { text-decoration: underline; }
  @media (max-width: 900px) {
    table { min-width: 0; }
    thead { display: none; }
    td.col-check, th.col-check, td.col-name, th.col-name { position: static; }
    tr.main-row { display: block; margin-bottom: 10px; padding: 10px; border: 1px solid var(--outline); border-radius: var(--radius); }
    tr.main-row > td { display: block; border: 0; padding: 2px 0; text-align: left; }
  }
</style>
</head>
<body>
<h1>SeaDrop 目标看板</h1>
<div class="meta">生成于 ${escapeHtml(meta.generatedAt)} · ${rows.length} 个目标 · 数据源：${escapeHtml(meta.sources.join("、"))}</div>
${serveBar}
<div class="cards">${cards}</div>
<div class="next-open">最近开售：${nextOpenText}</div>

<div class="tabs">
  <button type="button" data-tab="all" id="tabAll" class="on">全部</button>
  <button type="button" data-tab="favs" id="tabFavs">收藏 (${Object.keys(favorites.favorites).length})</button>
  <button type="button" data-tab="queue" id="tabQueue">执行队列 (${(opts.queue?.jobs ?? []).length})</button>
  <span id="favHint" class="muted"></span>
</div>

<div id="queuePanel" class="queue-panel" hidden>
  <div class="queue-head">
    <strong>执行队列</strong>
    <span id="queueArmed" class="muted"></span>
    <span id="queueHeartbeat" class="muted"></span>
    <button type="button" id="queueRefresh">刷新</button>
    <span class="muted">武装（填执行器打印的 token）</span>
    <input id="armToken" type="password" placeholder="arm token">
    <button type="button" id="queueArm">武装</button>
    <button type="button" id="queueDisarm">解除</button>
    <span id="queueNote" class="muted"></span>
  </div>
  <div id="queueList"></div>
</div>

<div id="missingFavs" class="missing" hidden>
  <div><strong>已不在板面</strong> <span class="muted">收藏仍在，只是这些目标已从当前视图移除（结束超一周或不再符合阶段）</span></div>
  ${missingFavorites
    .map(
      ([key, record]) => `<div class="missing-item">
    <span class="mono muted">${escapeHtml(record.chain)}|${escapeHtml(record.contract)}</span>
    <span class="name-main">${escapeHtml(record.name ?? record.slug ?? "—")}</span>
    <span class="muted">收藏于 ${escapeHtml((record.addedAt ?? "").slice(0, 16).replace("T", " "))}Z · ${escapeHtml(record.status)}</span>
    ${record.note ? `<span class="muted">备注：${escapeHtml(record.note)}</span>` : ""}
    <button type="button" data-remove-fav="${escapeHtml(key)}">移除</button>
  </div>`
    )
    .join("")}
</div>

<div class="controls">
  <label>等级
    <select id="gradeFilter">
      <option value="">全部</option>
      <option value="AB">A+B</option>
      <option>A</option><option>B</option><option>C</option><option>D</option>
    </select>
  </label>
  <label>阶段
    <select id="phaseFilter">
      <option value="focus">未开售 + 新开售</option>
      <option value="">全部</option>
      <option value="upcoming">未开售</option>
      <option value="live-fresh">新开售</option>
      <option value="live">在售</option>
      <option value="stale">陈旧</option>
      <option value="sold-out">售罄</option>
      <option value="ended">已结束</option>
      <option value="unaudited">待复审</option>
    </select>
  </label>
  <label>Q 分
    <select id="qFilter">
      <option value="">全部</option>
      <option value="40">≥ 40</option>
      <option value="60">≥ 60</option>
      <option value="80">≥ 80</option>
    </select>
  </label>
  <label>链 <select id="chainFilter"><option value="">全部</option></select></label>
  <label><input type="checkbox" id="freeOnly"> 仅免费</label>
  <label><input type="checkbox" id="onlyPending"> 仅队列中</label>
  <label><input type="checkbox" id="onlyExecuted"> 仅已执行</label>
  <label><input type="checkbox" id="excludeInstant"> 排除预计秒空</label>
  <label>搜索 <input id="search" type="search" placeholder="名称 / 合约 / 链"></label>
  <button id="presetFresh" class="primary">免费 · A/B · Q≥60 · 未开售</button>
  <span id="hiddenCount" class="muted"></span>
  <span id="freeNote" class="muted"></span>
  <span id="count" class="muted"></span>
</div>

<div class="table-wrap">
<table id="table">
<thead>
<tr>
  <th class="col-check"></th><th class="col-name" data-sort="target">名称 / 合约</th>
  <th data-sort="grade">等级</th><th class="num" data-sort="q">Q 分</th><th data-sort="phase">阶段</th><th data-sort="start">开售时间 (UTC+8)</th>
  <th class="num" data-sort="mintprice">价格</th><th class="num">每钱包上限</th>
  <th class="num" data-sort="mintedpct">已铸</th><th class="num" data-sort="remaining">剩余</th>
  <th class="num" data-sort="recent1h">15分 / 1时</th><th class="num" data-sort="minters">铸造地址</th>
  <th class="num" data-sort="velocity">24时速度 → 售罄预计</th><th>链接</th>
</tr>
</thead>
<tbody>
${rowHtml}
</tbody>
</table>
</div>

<div class="out">
  <div><strong>短名单</strong> <span class="muted">勾选的目标，每行一个合约地址（可存为 @shortlist.txt）</span></div>
  <textarea id="shortlist" readonly></textarea>
  <div style="margin-top:6px">
    <button id="copy">复制</button>
    <button id="exportTargets">导出 targets.json（收藏）</button>
    <button id="exportFavorites">导出 favorites.jsonl（分析）</button>
    <button id="enqueueFavorites">收藏加入执行队列</button>
    <button id="copyFilterLink">复制筛选链接</button>
    <span id="copyNote" class="muted"></span>
    <span id="favNote" class="muted"></span>
  </div>
  <pre id="commands" class="muted"></pre>
</div>

<script>
window.__SERVE__ = ${opts.serve ? "true" : "false"};
window.__FAVORITES__ = ${JSON.stringify({ version: 1, favorites: favorites.favorites }).replace(/</g, "\\u003c")};
window.__QUEUE__ = ${JSON.stringify(opts.queue ?? { jobs: [], armed: { armed: false }, heartbeat: null }).replace(/</g, "\\u003c")};
</script>
<script>
(function () {
  var table = document.getElementById("table");
  var rows = Array.prototype.slice.call(table.querySelectorAll("tr.main-row"));
  var chains = Array.from(new Set(rows.map(function (r) { return r.dataset.chain; }))).sort();
  var chainFilter = document.getElementById("chainFilter");
  chains.forEach(function (c) { var o = document.createElement("option"); o.value = c; o.textContent = c; chainFilter.appendChild(o); });

  var PHASE_ZH = { upcoming: "未开售", "live-fresh": "新开售", live: "在售", stale: "陈旧", "sold-out": "售罄", ended: "已结束", unaudited: "待复审" };

  function apply() {
    var grade = document.getElementById("gradeFilter").value;
    var chain = chainFilter.value;
    var pending = document.getElementById("onlyPending").checked;
    var executed = document.getElementById("onlyExecuted").checked;
    var freeOnly = document.getElementById("freeOnly").checked;
    var excludeInstant = document.getElementById("excludeInstant").checked;
    var phaseFilter = document.getElementById("phaseFilter").value;
    var qMin = parseInt(document.getElementById("qFilter").value, 10) || 0;
    var q = document.getElementById("search").value.toLowerCase();
    var visible = 0;
    var hiddenByPhase = {};
    rows.forEach(function (r) {
      var matches = (!grade || r.dataset.grade === grade || (grade === "AB" && (r.dataset.grade === "A" || r.dataset.grade === "B")))
        && (!chain || r.dataset.chain === chain)
        && (!pending || r.dataset.pending === "1")
        && (!executed || r.dataset.executed === "1")
        && (!freeOnly || r.dataset.free === "1" || r.dataset.free === "")
        && (!excludeInstant || r.dataset.instant !== "1")
        && (!qMin || (r.dataset.q !== "" && parseFloat(r.dataset.q) >= qMin))
        && (!q || r.dataset.target.toLowerCase().indexOf(q) >= 0);
      var phase = r.dataset.phase;
      var phaseOk = !phaseFilter
        || (phaseFilter === "focus" ? (phase === "upcoming" || phase === "live-fresh") : phase === phaseFilter);
      if (matches && !phaseOk) hiddenByPhase[phase] = (hiddenByPhase[phase] || 0) + 1;
      var ok = matches && phaseOk;
      r.style.display = ok ? "" : "none";
      var detail = r.nextElementSibling;
      if (detail && detail.classList.contains("detail")) detail.hidden = !ok || !r.classList.contains("open");
      if (ok) visible++;
    });
    document.getElementById("count").textContent = visible + " 行";
    var hiddenText = Object.keys(hiddenByPhase).map(function (p) { return (PHASE_ZH[p] || p) + " " + hiddenByPhase[p]; }).join(" · ");
    document.getElementById("hiddenCount").textContent = hiddenText ? "已隐藏：" + hiddenText : "";
    var unknownPrice = freeOnly ? rows.filter(function (r) { return r.dataset.free === ""; }).length : 0;
    document.getElementById("freeNote").textContent = unknownPrice > 0 ? unknownPrice + " 行价格未知" : "";
    updateShortlist();
  }

  function updateShortlist() {
    var picked = Array.prototype.slice.call(document.querySelectorAll(".pick:checked"));
    document.getElementById("shortlist").value = picked.map(function (p) { return p.value; }).join("\\n");
    var byChain = {};
    picked.forEach(function (p) { (byChain[p.dataset.chain] = byChain[p.dataset.chain] || []).push(p.value); });
    var commands = Object.keys(byChain).map(function (c) {
      return "npm start -- --audit " + byChain[c].join(" ") + " --chain " + c +
        " --export targets." + c + ".json --quantity 1 --max-price current --force";
    }).join("\\n");
    document.getElementById("commands").textContent = commands;
  }

  ["gradeFilter", "chainFilter", "onlyPending", "onlyExecuted", "freeOnly", "excludeInstant", "phaseFilter", "qFilter"].forEach(function (id) {
    document.getElementById(id).addEventListener("change", apply);
  });
  document.getElementById("presetFresh").addEventListener("click", function () {
    document.getElementById("gradeFilter").value = "AB";
    document.getElementById("freeOnly").checked = true;
    document.getElementById("phaseFilter").value = "focus";
    document.getElementById("qFilter").value = "60";
    document.getElementById("excludeInstant").checked = true;
    document.getElementById("onlyPending").checked = false;
    document.getElementById("onlyExecuted").checked = false;
    apply();
  });
  document.getElementById("search").addEventListener("input", apply);
  table.querySelector("thead").addEventListener("click", function (event) {
    var th = event.target.closest("th[data-sort]");
    if (!th) return;
    var key = th.dataset.sort;
    var desc = th.dataset.desc === "1";
    rows.sort(function (a, b) {
      var av = a.dataset[key] || "", bv = b.dataset[key] || "";
      var an = parseFloat(av), bn = parseFloat(bv);
      var cmp = (!isNaN(an) && !isNaN(bn)) ? an - bn : av.localeCompare(bv);
      return desc ? -cmp : cmp;
    });
    rows.forEach(function (r) {
      var detail = r.nextElementSibling;
      table.tBodies[0].appendChild(r);
      if (detail && detail.classList.contains("detail")) table.tBodies[0].appendChild(detail);
    });
    th.dataset.desc = desc ? "0" : "1";
  });
  rows.forEach(function (r) {
    r.addEventListener("click", function (event) {
      if (event.target.closest("a") || event.target.closest("input")) return;
      var detail = r.nextElementSibling;
      r.classList.toggle("open");
      if (detail && detail.classList.contains("detail")) detail.hidden = !r.classList.contains("open");
    });
  });
  window.__PANEL__ = { apply: apply, rows: rows };
  document.querySelectorAll(".pick").forEach(function (p) { p.addEventListener("change", updateShortlist); });
  document.getElementById("copy").addEventListener("click", function () {
    var area = document.getElementById("shortlist");
    area.select();
    var done = function () { document.getElementById("copyNote").textContent = "已复制"; };
    if (navigator.clipboard) navigator.clipboard.writeText(area.value).then(done, done);
    else { document.execCommand("copy"); done(); }
  });
  apply();
})();
</script>
${serveScript}
<script>
${FAVORITES_CLIENT}
</script>
</body>
</html>
`;
}
