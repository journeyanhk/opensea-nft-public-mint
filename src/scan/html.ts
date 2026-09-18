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
import { ScanState } from "./state";
import { toUtc8Time } from "../time-format";

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
  execution: { status: string; txHash: string | null; at: string; quantity: number } | null;
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

// Structural facts come from the state file; change and concentration labels are
// taken verbatim from the last audit (single source — the auditor already knows
// about scan coverage, so a partial scan cannot produce a misleading label).
function deriveNotes(input: { soldOut: boolean; pendingAudit: boolean; auditRisks: string[] }): string[] {
  const notes: string[] = [];
  if (input.soldOut) notes.push("sold out");
  if (input.pendingAudit) notes.push("queued (over limit)");
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
  for (const record of backfills) {
    const key = `${record.chain}|${record.contract.toLowerCase()}`;
    const nets = netsByTarget.get(key) ?? {};
    const net = formatNetUsd(record);
    if (net !== null) nets[String(record.checkpointHours)] = net;
    netsByTarget.set(key, nets);
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
    });
    byTarget.set(key, points);
  }

  const rows: DashboardRow[] = [];
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
          }
        : null;
      const start = entry.publicStart ?? latest?.start ?? null;
      const topShare = cached?.mintScan.topMinterShare ?? null;

      const minted = latest?.minted != null ? BigInt(latest.minted) : null;
      const maxSupply = latest?.maxSupply != null ? BigInt(latest.maxSupply) : null;
      const remainingNow = latest?.remaining != null ? BigInt(latest.remaining) : null;
      const fallbackPerHour =
        latest?.recent1h != null
          ? BigInt(latest.recent1h)
          : latest?.recent15m != null
            ? BigInt(latest.recent15m) * 4n
            : null;
      const velocity = velocityPer24h(points, fallbackPerHour);
      const nowSec = Math.floor(Date.now() / 1000);
      const stale = staleVerdict({
        startSec: start,
        nowSec,
        minted,
        maxSupply,
        velocityPer24h: velocity.per24h,
      });
      const explorer = resolveChain(chain)?.explorer ?? "";

      rows.push({
        chain,
        contract,
        start,
        grade: entry.lastGrade ?? latest?.grade ?? null,
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
        }),
        slug: latest?.slug ?? null,
        name: latest?.name ?? null,
        owner: latest?.owner ?? null,
        mintPriceWei: latest?.mintPriceWei ?? null,
        capPerWallet: latest?.capPerWallet ?? null,
        endTime: latest?.endTime ?? null,
        maxSupply: latest?.maxSupply ?? null,
        minted: latest?.minted ?? null,
        recent15m: latest?.recent15m ?? null,
        recent1h: latest?.recent1h ?? null,
        uniqueMinters: latest?.uniqueMinters ?? null,
        presaleStages: latest?.presaleStages ?? null,
        velocity24h: velocity.per24h === null ? null : velocity.per24h.toString(),
        velocitySource: velocity.source,
        sellOutEtaHours: sellOutEtaHours(remainingNow, velocity.per24h),
        stale,
        links: {
          opensea: latest?.slug
            ? `https://opensea.io/collection/${latest.slug}`
            : `https://opensea.io/assets/${chain}/${contract}/1`,
          explorer: explorer ? `${explorer}/address/${contract}` : "",
        },
      });
    }
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

export function sellOutEtaHours(remaining: bigint | null, velocityPer24h: bigint | null): number | null {
  if (remaining === null || velocityPer24h === null || velocityPer24h <= 0n || remaining < 0n) return null;
  const hours = Number((remaining * 24n) / velocityPer24h);
  return Number.isFinite(hours) ? hours : null;
}

export interface DashboardMeta {
  generatedAt: string;
  sources: string[];
}

export function renderDashboard(rows: DashboardRow[], meta: DashboardMeta, opts: { serve?: boolean } = {}): string {
  const explorerTx = (chain: string, hash: string | null): string | null => {
    if (!hash) return null;
    const explorer = resolveChain(chain)?.explorer;
    return explorer ? `${explorer}/tx/${hash}` : null;
  };

  const rowHtml = rows
    .map((row) => {
      const startSec = row.start;
      const startText = startSec === null ? "" : toUtc8Time(new Date(startSec * 1000));
      const window = describeWindow(startSec, row.endTime);
      const history = row.gradeHistory.map((p) => `${p.grade}@${p.at.slice(5, 16)}`).join(" → ");
      const stages = row.stages.map((s) => `#${s.stage} ${s.tokens}`).join(" | ");
      const txUrl = explorerTx(row.chain, row.execution?.txHash ?? null);
      const price = row.mintPriceWei === null ? null : BigInt(row.mintPriceWei);
      const priceText = price === null ? "" : price === 0n ? "FREE" : `${formatEther(price)}`;
      const capText = row.capPerWallet === null ? "" : row.capPerWallet === 0 ? "∞" : String(row.capPerWallet);
      const mintedPct =
        row.minted !== null && row.maxSupply !== null && BigInt(row.maxSupply) > 0n
          ? Number((BigInt(row.minted) * 10_000n) / BigInt(row.maxSupply)) / 100
          : null;
      const velocityText =
        row.velocity24h === null
          ? ""
          : `${row.velocity24h}${row.velocitySource === "bucket" ? " (1h est)" : ""}`;
      const etaText =
        row.sellOutEtaHours === null
          ? ""
          : row.sellOutEtaHours < 1
            ? "<1h"
            : row.sellOutEtaHours < 48
              ? `${Math.round(row.sellOutEtaHours)}h`
              : `${(row.sellOutEtaHours / 24).toFixed(1)}d`;
      const data = [
        `data-chain="${escapeHtml(row.chain)}"`,
        `data-grade="${escapeHtml(row.grade ?? "")}"`,
        `data-start="${row.start ?? ""}"`,
        `data-pending="${row.pendingAudit ? "1" : "0"}"`,
        `data-executed="${row.execution ? "1" : "0"}"`,
        `data-net24="${escapeHtml(row.nets["24"] ?? "")}"`,
        `data-net72="${escapeHtml(row.nets["72"] ?? "")}"`,
        `data-net24usd="${escapeHtml(row.nets["24"] ?? "")}"`,
        `data-net72usd="${escapeHtml(row.nets["72"] ?? "")}"`,
        `data-stale="${row.stale ? "1" : "0"}"`,
        `data-free="${price === null ? "" : price === 0n ? "1" : "0"}"`,
        `data-name="${escapeHtml(row.name ?? "")}"`,
        `data-velocity="${escapeHtml(row.velocity24h ?? "")}"`,
        `data-mintprice="${escapeHtml(row.mintPriceWei ?? "")}"`,
        `data-remaining="${escapeHtml(row.remaining ?? "")}"`,
        `data-notes="${escapeHtml(row.notes.join("; "))}"`,
        `data-mintedpct="${mintedPct === null ? "" : mintedPct}"`,
        `data-target="${escapeHtml(`${row.name ?? ""} ${row.contract} ${row.chain}`)}"`,
      ].join(" ");
      const links = [
        row.links.opensea ? `<a href="${escapeHtml(row.links.opensea)}" target="_blank" rel="noreferrer">OS</a>` : "",
        row.links.explorer ? `<a href="${escapeHtml(row.links.explorer)}" target="_blank" rel="noreferrer">scan</a>` : "",
      ]
        .filter(Boolean)
        .join(" ");
      return `<tr ${data}>
  <td><input type="checkbox" class="pick" value="${escapeHtml(row.contract)}" data-chain="${escapeHtml(row.chain)}"></td>
  <td><span class="grade g-${escapeHtml(row.grade ?? "?")}">${escapeHtml(row.grade ?? "?")}</span></td>
  <td>${escapeHtml(row.chain)}</td>
  <td>${escapeHtml(row.name ?? "")}<div class="mono small">${escapeHtml(row.contract)}</div></td>
  <td>${startSec === null ? "" : escapeHtml(startText)}<div class="small">${escapeHtml(window)}</div></td>
  <td>${price !== null && price === 0n ? `<span class="free">FREE</span>` : escapeHtml(priceText)}</td>
  <td>${escapeHtml(capText)}</td>
  <td>${row.minted ?? ""}${mintedPct === null ? "" : ` <span class="small">(${mintedPct.toFixed(1)}%)</span>`}</td>
  <td>${escapeHtml(row.remaining ?? "")}</td>
  <td>${escapeHtml(row.recent15m ?? "")} / ${escapeHtml(row.recent1h ?? "")}</td>
  <td>${row.uniqueMinters ?? ""}${row.topMinterShare === null ? "" : ` <span class="small">top ${Math.round(row.topMinterShare * 100)}%</span>`}</td>
  <td>${row.presaleStages === null || row.presaleStages === 0 ? "" : "yes"}</td>
  <td>${escapeHtml(velocityText)}${etaText ? ` <span class="small">→ ${escapeHtml(etaText)}</span>` : ""}</td>
  <td>${row.stale ? `<span class="stale">stale</span>` : ""}</td>
  <td>${links}</td>
  <td>${escapeHtml(row.notes.join("; "))}</td>
  <td>${escapeHtml(row.execution ? row.execution!.status : "")}${txUrl ? ` <a href="${escapeHtml(txUrl)}" target="_blank" rel="noreferrer">tx</a>` : ""}</td>
  <td>${escapeHtml(row.nets["24"] ?? "")}</td>
  <td>${escapeHtml(row.nets["72"] ?? "")}</td>
  <td class="mono small">${escapeHtml(history)}</td>
</tr>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="300">
<title>Mint dashboard</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 13px/1.5 -apple-system, "Segoe UI", Roboto, sans-serif; margin: 16px; }
  h1 { font-size: 16px; margin: 0 0 4px; }
  .meta { color: #888; margin-bottom: 12px; }
  .controls { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; margin-bottom: 10px; }
  .controls label { display: inline-flex; gap: 4px; align-items: center; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border-bottom: 1px solid #8883; padding: 4px 6px; text-align: left; vertical-align: top; }
  th { cursor: pointer; user-select: none; white-space: nowrap; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .small { font-size: 11px; color: #888; }
  .grade { display: inline-block; min-width: 16px; text-align: center; border-radius: 4px; padding: 0 4px; color: #fff; }
  .g-A { background: #2e7d32; } .g-B { background: #f9a825; color: #222; }
  .free { color: #2e7d32; font-weight: 700; }
  .stale { color: #c62828; }
  .controls button { font-weight: 600; }
  .g-C { background: #c62828; } .g-D { background: #6a1b9a; } .g-\\? { background: #777; }
  textarea { width: 100%; min-height: 80px; font-family: ui-monospace, monospace; }
  .out { margin-top: 14px; }
  button { padding: 4px 10px; }
  .status { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin: 6px 0 12px; padding: 6px 8px; border: 1px solid #8883; border-radius: 6px; }
  .status .state { font-weight: 600; }
  .status .last { color: #888; }
</style>
</head>
<body>
<h1>Mint dashboard</h1>
<div class="meta">generated ${escapeHtml(meta.generatedAt)} · ${rows.length} target(s) · sources: ${escapeHtml(meta.sources.join(", "))}</div>

${opts.serve ? `<div class="status" id="statusBar">
  <span class="state" id="stState">starting…</span>
  <button id="scanNow">Scan now</button>
  <span class="last" id="stLog"></span>
</div>

` : ""}

<div class="controls">
  <label>grade
    <select id="gradeFilter">
      <option value="">all</option>
      <option value="AB">A+B</option>
      <option>A</option><option>B</option><option>C</option><option>D</option>
    </select>
  </label>
  <label>chain
    <select id="chainFilter"><option value="">all</option></select>
  </label>
  <label><input type="checkbox" id="freeOnly"> free only</label>
  <label><input type="checkbox" id="onlyPending"> queued only</label>
  <label><input type="checkbox" id="onlyExecuted"> executed only</label>
  <label><input type="checkbox" id="showStale"> show stale</label>
  <button id="presetFresh">FREE · A/B · fresh</button>
  <span id="staleCount" class="small"></span>
  <span id="freeNote" class="small"></span>
  <label>search <input id="search" type="search" placeholder="contract / chain"></label>
  <span id="count"></span>
</div>

<table id="table">
<thead>
<tr>
  <th></th><th data-sort="grade">grade</th><th data-sort="chain">chain</th><th data-sort="target">name / contract</th>
  <th data-sort="start">start (UTC+8) / window</th><th data-sort="mintprice">price</th><th>cap</th>
  <th data-sort="mintedpct">minted (%)</th><th data-sort="remaining">left</th><th data-sort="velocity">15m / 1h</th>
  <th>minters (top%)</th><th>pre</th><th data-sort="velocity">24h vel → eta</th><th data-sort="stale">stale</th><th>links</th>
  <th data-sort="notes">notes</th><th>execution</th><th data-sort="net24usd">24h net</th><th data-sort="net72usd">72h net</th><th>grade history</th>
</tr>
</thead>
<tbody>
${rowHtml}
</tbody>
</table>

<div class="out">
  <div><strong>shortlist</strong> — checked targets, one contract per line (@shortlist.txt)</div>
  <textarea id="shortlist" readonly></textarea>
  <div style="margin-top:6px">
    <button id="copy">copy</button>
    <span id="copyNote" class="small"></span>
  </div>
  <pre id="commands" class="small"></pre>
</div>

<script>
(function () {
  var table = document.getElementById("table");
  var rows = Array.prototype.slice.call(table.tBodies[0].rows);
  var chains = Array.from(new Set(rows.map(function (r) { return r.dataset.chain; }))).sort();
  var chainFilter = document.getElementById("chainFilter");
  chains.forEach(function (c) { var o = document.createElement("option"); o.value = c; o.textContent = c; chainFilter.appendChild(o); });

  function apply() {
    var grade = document.getElementById("gradeFilter").value;
    var chain = chainFilter.value;
    var pending = document.getElementById("onlyPending").checked;
    var executed = document.getElementById("onlyExecuted").checked;
    var freeOnly = document.getElementById("freeOnly").checked;
    var showStale = document.getElementById("showStale").checked;
    var q = document.getElementById("search").value.toLowerCase();
    var visible = 0;
    var staleHidden = 0;
    rows.forEach(function (r) {
      var matches = (!grade || r.dataset.grade === grade || (grade === "AB" && (r.dataset.grade === "A" || r.dataset.grade === "B")))
        && (!chain || r.dataset.chain === chain)
        && (!pending || r.dataset.pending === "1")
        && (!executed || r.dataset.executed === "1")
        && (!freeOnly || r.dataset.free === "1" || r.dataset.free === "")
        && (!q || r.dataset.target.toLowerCase().indexOf(q) >= 0);
      var staleBlocked = matches && !showStale && r.dataset.stale === "1";
      if (staleBlocked) staleHidden++;
      var ok = matches && !staleBlocked;
      r.style.display = ok ? "" : "none";
      if (ok) visible++;
    });
    document.getElementById("count").textContent = visible + " shown";
    document.getElementById("staleCount").textContent = staleHidden > 0 ? staleHidden + " stale hidden" : "";
    var unknownPrice = freeOnly ? rows.filter(function (r) { return r.dataset.free === ""; }).length : 0;
    document.getElementById("freeNote").textContent = unknownPrice > 0 ? unknownPrice + " price unknown" : "";
    updateShortlist();
  }

  function updateShortlist() {
    var picked = Array.prototype.slice.call(document.querySelectorAll(".pick:checked"));
    var lines = picked.map(function (p) { return p.value; });
    document.getElementById("shortlist").value = lines.join("\\n");
    var byChain = {};
    picked.forEach(function (p) { (byChain[p.dataset.chain] = byChain[p.dataset.chain] || []).push(p.value); });
    // Inline the addresses: --audit takes multiple targets, so no @file is needed.
    var commands = Object.keys(byChain).map(function (c) {
      return "npm start -- --audit " + byChain[c].join(" ") + " --chain " + c +
        " --export targets." + c + ".json --quantity 1 --max-price current --force";
    }).join("\\n");
    document.getElementById("commands").textContent = commands;
  }

  ["gradeFilter", "chainFilter", "onlyPending", "onlyExecuted", "freeOnly", "showStale"].forEach(function (id) {
    document.getElementById(id).addEventListener("change", apply);
  });
  document.getElementById("presetFresh").addEventListener("click", function () {
    document.getElementById("gradeFilter").value = "AB";
    document.getElementById("freeOnly").checked = true;
    document.getElementById("showStale").checked = false;
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
    rows.forEach(function (r) { table.tBodies[0].appendChild(r); });
    th.dataset.desc = desc ? "0" : "1";
  });
  document.querySelectorAll(".pick").forEach(function (p) { p.addEventListener("change", updateShortlist); });
  document.getElementById("copy").addEventListener("click", function () {
    var area = document.getElementById("shortlist");
    area.select();
    var done = function () { document.getElementById("copyNote").textContent = "copied"; };
    if (navigator.clipboard) navigator.clipboard.writeText(area.value).then(done, done);
    else { document.execCommand("copy"); done(); }
  });
  apply();
})();
</script>
<script>
(function () {
  if (!document.getElementById("statusBar")) return;
  var state = document.getElementById("stState");
  var log = document.getElementById("stLog");
  var button = document.getElementById("scanNow");
  function refresh() {
    fetch("/api/status", { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (s) {
      var parts = [s.running ? "scanning…" : "idle"];
      if (s.lastScanAt) parts.push("last " + s.lastScanAt.slice(11, 16) + "Z");
      if (s.nextScanAt) parts.push("next " + s.nextScanAt.slice(11, 16) + "Z");
      parts.push((s.rowCount || 0) + " rows");
      if (s.lastError) parts.push("error: " + s.lastError);
      state.textContent = parts.join(" · ");
      if (s.log && s.log.length) log.textContent = s.log[s.log.length - 1].slice(11, 19) + " " + s.log[s.log.length - 1].slice(30);
    }).catch(function () { state.textContent = "status unavailable"; });
  }
  button.addEventListener("click", function () {
    button.disabled = true;
    fetch("/api/scan", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || String(r.status)); return j; }); })
      .catch(function (e) { alert("scan: " + e.message); })
      .then(function () { button.disabled = false; refresh(); });
  });
  refresh();
  setInterval(refresh, 15000);
})();
</script>
</body>
</html>
`;
}
