// Static dashboard: one HTML file generated from the local scan state, the audit
// history and the execution ledger. No server, no external assets, no network.
//
// Everything dynamic is escaped; the filtering, sorting and shortlist generation
// are a few lines of inline vanilla JS.

import fs from "fs";
import { resolveChain } from "../chains";
import { CachedScan, readCachedScan } from "../audit/audit";
import { Ledger, entryOf } from "../batch-ledger";
import { BackfillRecord, formatNet } from "./backfill";
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
}

export interface GradePoint {
  at: string;
  grade: string;
  remaining: string | null;
  projected: string | null;
  start: number | null;
  risks?: string[];
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
    const net = formatNet(record);
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
      });
    }
  }

  rows.sort((a, b) => (a.start ?? Number.MAX_SAFE_INTEGER) - (b.start ?? Number.MAX_SAFE_INTEGER));
  return rows;
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface DashboardMeta {
  generatedAt: string;
  sources: string[];
}

export function renderDashboard(rows: DashboardRow[], meta: DashboardMeta): string {
  const explorerTx = (chain: string, hash: string | null): string | null => {
    if (!hash) return null;
    const explorer = resolveChain(chain)?.explorer;
    return explorer ? `${explorer}/tx/${hash}` : null;
  };

  const rowHtml = rows
    .map((row) => {
      const start = row.start === null ? "" : toUtc8Time(new Date(row.start * 1000));
      const history = row.gradeHistory.map((p) => `${p.grade}@${p.at.slice(5, 16)}`).join(" → ");
      const stages = row.stages.map((s) => `#${s.stage} ${s.tokens}`).join(" | ");
      const txUrl = explorerTx(row.chain, row.execution?.txHash ?? null);
      const execution = row.execution
        ? `${row.execution.status}${txUrl ? ` <a href="${escapeHtml(txUrl)}" target="_blank" rel="noreferrer">tx</a>` : ""}`
        : "";
      const data = [
        `data-chain="${escapeHtml(row.chain)}"`,
        `data-grade="${escapeHtml(row.grade ?? "")}"`,
        `data-start="${row.start ?? ""}"`,
        `data-pending="${row.pendingAudit ? "1" : "0"}"`,
        `data-executed="${row.execution ? "1" : "0"}"`,
        `data-net24="${escapeHtml(row.nets["24"] ?? "")}"`,
        `data-net72="${escapeHtml(row.nets["72"] ?? "")}"`,
        `data-target="${escapeHtml(`${row.contract} ${row.chain}`)}"`,
      ].join(" ");
      return `<tr ${data}>
  <td><input type="checkbox" class="pick" value="${escapeHtml(row.contract)}" data-chain="${escapeHtml(row.chain)}"></td>
  <td><span class="grade g-${escapeHtml(row.grade ?? "?")}">${escapeHtml(row.grade ?? "?")}</span></td>
  <td>${escapeHtml(row.chain)}</td>
  <td class="mono">${escapeHtml(row.contract)}</td>
  <td>${escapeHtml(start)}</td>
  <td>${escapeHtml(row.remaining ?? "")}</td>
  <td>${escapeHtml(row.projected ?? "")}</td>
  <td>${escapeHtml(stages)}</td>
  <td>${escapeHtml(row.notes.join("; "))}</td>
  <td>${escapeHtml(execution ? row.execution!.status : "")}${txUrl ? ` <a href="${escapeHtml(txUrl)}" target="_blank" rel="noreferrer">tx</a>` : ""}</td>
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
  .g-C { background: #c62828; } .g-D { background: #6a1b9a; } .g-\\? { background: #777; }
  textarea { width: 100%; min-height: 80px; font-family: ui-monospace, monospace; }
  .out { margin-top: 14px; }
  button { padding: 4px 10px; }
</style>
</head>
<body>
<h1>Mint dashboard</h1>
<div class="meta">generated ${escapeHtml(meta.generatedAt)} · ${rows.length} target(s) · sources: ${escapeHtml(meta.sources.join(", "))}</div>

<div class="controls">
  <label>grade
    <select id="gradeFilter">
      <option value="">all</option>
      <option>A</option><option>B</option><option>C</option><option>D</option>
    </select>
  </label>
  <label>chain
    <select id="chainFilter"><option value="">all</option></select>
  </label>
  <label><input type="checkbox" id="onlyPending"> queued only</label>
  <label><input type="checkbox" id="onlyExecuted"> executed only</label>
  <label>search <input id="search" type="search" placeholder="contract / chain"></label>
  <span id="count"></span>
</div>

<table id="table">
<thead>
<tr>
  <th></th><th data-sort="grade">grade</th><th data-sort="chain">chain</th><th data-sort="target">contract</th>
  <th data-sort="start">start (UTC+8)</th><th data-sort="remaining">left</th><th data-sort="projected">projected</th>
  <th>stages</th>  <th data-sort="notes">notes</th><th>execution</th><th data-sort="net24">24h net</th><th data-sort="net72">72h net</th><th>grade history</th>
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
    var q = document.getElementById("search").value.toLowerCase();
    var visible = 0;
    rows.forEach(function (r) {
      var ok = (!grade || r.dataset.grade === grade)
        && (!chain || r.dataset.chain === chain)
        && (!pending || r.dataset.pending === "1")
        && (!executed || r.dataset.executed === "1")
        && (!q || r.dataset.target.toLowerCase().indexOf(q) >= 0);
      r.style.display = ok ? "" : "none";
      if (ok) visible++;
    });
    document.getElementById("count").textContent = visible + " shown";
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

  ["gradeFilter", "chainFilter", "onlyPending", "onlyExecuted"].forEach(function (id) {
    document.getElementById(id).addEventListener("change", apply);
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
</body>
</html>
`;
}
