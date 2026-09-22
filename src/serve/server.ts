// The serve-mode HTTP surface. Node's built-in http is enough: a handful of
// routes, no static assets (the dashboard is one inline-HTML document) and no
// WebSocket (the status bar polls every 15s).
//
// State-changing requests must be `content-type: application/json` and
// same-origin. A cross-site HTML form cannot send that content type, and we
// return no CORS headers, so this closes the CSRF gap that basic-auth alone
// leaves open.

import http from "http";
import path from "path";
import { maskRpc } from "../rpc-resolver";
import { renderDashboard } from "../scan/html";
import { resolveChain } from "../chains";
import fs from "fs";
import { cancelJob, clearArmed, enqueueJob, isArmed, listJobs, setArmed } from "../executor/queue";
import { previewJob, summarizeQueue } from "../executor/preview";
import { DEFAULT_STATE_PATH, loadState } from "../scan/state";
import {
  DEFAULT_FAVORITES_PATH,
  FavoriteSnapshot,
  FavoriteStatus,
  loadFavorites,
  removeFavorite,
  saveFavorites,
  toJsonl,
  upsertFavorite,
} from "../scan/favorites";
import { ServeConfig } from "./config";
import { Scheduler } from "./scheduler";

const MAX_BODY_BYTES = 64 * 1024;
const SCAN_THROTTLE_MS = 5_000;

export interface ServerOptions {
  scheduler: Scheduler;
  exportsDir: string;
  favoritesPath?: string;
  queueDir?: string;
  statePath?: string;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (text.length === 0) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error("request body is not valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

// Log lines can contain RPC URLs (with API keys in the path) and local paths;
// both are stripped before anything leaves the process.
export function sanitizeLog(lines: string[]): string[] {
  return lines.map((line) =>
    line
      .replace(/https?:\/\/[^\s)]+/g, (url) => maskRpc(url))
      .replace(/(?:^|\s)\/[^\s]{10,}/g, (match) => `${match[0] === " " ? " " : ""}<path>`)
  );
}

const MAX_ENQUEUE_PER_HOUR = 10;

export function createServer(options: ServerOptions): http.Server {
  const { scheduler } = options;
  const favoritesPath = options.favoritesPath ?? DEFAULT_FAVORITES_PATH;
  const queueDir = options.queueDir ?? path.resolve(process.cwd(), "queue");
  const statePath = options.statePath ?? DEFAULT_STATE_PATH;

  // The executor publishes its heartbeat (and its wallet snapshot) into the queue
  // directory; the page and the queue API both read the same file.
  const readHeartbeat = (): {
    at?: string;
    host?: string;
    pid?: number;
    wallets?: { address: string; balanceWei: string; nonce: number }[];
  } | null => {
    try {
      return JSON.parse(fs.readFileSync(path.join(queueDir, "_heartbeat.json"), "utf8"));
    } catch {
      return null;
    }
  };
  let lastScanRequest = 0;

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

      if (req.method === "POST") {
        const contentType = String(req.headers["content-type"] ?? "").toLowerCase();
        if (!contentType.includes("application/json")) {
          return sendJson(res, 415, { error: "content-type must be application/json" });
        }
        const origin = req.headers.origin;
        const host = req.headers.host;
        if (origin && host) {
          try {
            if (new URL(origin).host !== host) return sendJson(res, 403, { error: "cross-origin request refused" });
          } catch {
            return sendJson(res, 400, { error: "invalid origin" });
          }
        }
      }

      // ── execution queue: the panel enqueues freely, the executor spends ──
      if (url.pathname === "/api/queue" || url.pathname.startsWith("/api/queue/")) {
        const action = url.pathname.replace("/api/queue", "").replace(/^\//, "");
        if (req.method === "GET" && action === "") {
          const jobs = listJobs(queueDir, Date.now());
          return sendJson(res, 200, {
            jobs: jobs.slice(0, 200),
            armed: isArmed(queueDir, Date.now()),
            heartbeat: readHeartbeat(),
            summary: summarizeQueue(jobs, Date.now()),
          });
        }
        if (req.method === "POST") {
          const body = (await readJsonBody(req)) as Record<string, unknown>;
          if (action === "arm") {
            const result = setArmed(queueDir, { token: String(body.token ?? ""), nowMs: Date.now() });
            return sendJson(res, result.ok ? 200 : 403, result.ok ? { armed: isArmed(queueDir, Date.now()) } : { error: result.reason });
          }
          if (action === "disarm") {
            clearArmed(queueDir);
            return sendJson(res, 200, { armed: { armed: false } });
          }
          if (action === "preview") {
            const chain = String(body.chain ?? "").toLowerCase();
            const contract = String(body.contract ?? "").toLowerCase();
            if (!resolveChain(chain)) return sendJson(res, 400, { error: `unsupported chain "${chain}"` });
            if (!/^0x[0-9a-f]{40}$/i.test(contract)) return sendJson(res, 400, { error: "contract must be a 0x-prefixed 20-byte address" });
            const { state } = loadState(statePath);
            const entry = state.contracts[chain]?.[contract] ?? null;
            const gasGwei = Number(process.env.MAX_FEE_PER_GAS ?? "2");
            const result = previewJob({
              chain,
              contract,
              quantity: Math.max(1, Math.floor(Number(body.quantity ?? 1)) || 1),
              startAtMs: Number(body.startAtMs) > 0 ? Number(body.startAtMs) : null,
              entry: entry
                ? {
                    mintPriceWei: entry.mintPriceWei,
                    capPerWallet: entry.capPerWallet,
                    codeHash: entry.codeHash,
                    publicStart: entry.publicStart,
                  }
                : null,
              existing: listJobs(queueDir, Date.now()).map((job) => ({
                id: job.id,
                chain: job.chain,
                contract: job.contract,
                startAtMs: job.startAtMs,
                status: job.view,
              })),
              freeMaxQuantity: Number(process.env.FREE_MAX_QUANTITY ?? "10") || 10,
              gasLimit: Number(process.env.GAS_LIMIT ?? "250000") || 250_000,
              maxFeePerGasWei: String(Math.round((Number.isFinite(gasGwei) && gasGwei > 0 ? gasGwei : 2) * 1e9)),
              riskFlags: Array.isArray(body.riskFlags) ? body.riskFlags.map(String).slice(0, 8) : [],
            });
            return sendJson(res, 200, result);
          }

          if (action === "cancel") {
            const id = String(body.id ?? "");
            if (!id) return sendJson(res, 400, { error: "id is required" });
            const result = cancelJob(queueDir, id, Date.now());
            return sendJson(res, result.ok ? 200 : 404, result.ok ? result : { error: result.reason });
          }
          if (action === "") {
            if (typeof body.chain === "string" && !resolveChain(body.chain)) {
              return sendJson(res, 400, { error: `unsupported chain "${body.chain}"` });
            }
            const since = Date.now() - 3_600_000;
            const recent = listJobs(queueDir, Date.now()).filter((job) => Date.parse(job.createdAt) >= since).length;
            if (recent >= MAX_ENQUEUE_PER_HOUR) {
              return sendJson(res, 429, { error: `${MAX_ENQUEUE_PER_HOUR} jobs were enqueued in the last hour — refusing more` });
            }
            const created = enqueueJob(queueDir, body as never, Date.now());
            return sendJson(res, created.ok ? 200 : 400, created);
          }
          return sendJson(res, 404, { error: "unknown queue action" });
        }
        return sendJson(res, 405, { error: "method not allowed" });
      }

      if (url.pathname === "/api/favorites") {
        if (req.method === "GET") {
          const store = loadFavorites(favoritesPath);
          if (url.searchParams.get("format") === "jsonl") {
            // The analysis export: one labelled row per favorite, snapshot
            // included, ready to join with ledger and backfill outcomes.
            const body = toJsonl(store);
            res.writeHead(200, {
              "content-type": "application/x-ndjson; charset=utf-8",
              "content-disposition": 'attachment; filename="favorites.jsonl"',
              "cache-control": "no-store",
            });
            return res.end(body);
          }
          return sendJson(res, 200, store);
        }
        if (req.method === "POST") {
          const body = (await readJsonBody(req)) as {
            action?: string;
            chain?: string;
            contract?: string;
            slug?: string | null;
            name?: string | null;
            status?: FavoriteStatus;
            note?: string;
            snapshot?: FavoriteSnapshot | null;
          };
          if (!body?.chain || !body?.contract) return sendJson(res, 400, { error: "chain and contract are required" });
          // Keep junk out of .favorites.json: it is an analysis dataset, and an
          // address typo or a stray chain would silently poison it.
          if (!resolveChain(body.chain)) return sendJson(res, 400, { error: `unsupported chain "${body.chain}"` });
          if (!/^0x[0-9a-f]{40}$/i.test(body.contract)) return sendJson(res, 400, { error: "contract must be a 0x-prefixed 20-byte address" });
          if (typeof body.note === "string" && body.note.length > 500) return sendJson(res, 400, { error: "note is longer than 500 characters" });
          if (typeof body.slug === "string" && body.slug.length > 200) return sendJson(res, 400, { error: "slug is longer than 200 characters" });
          if (body.snapshot !== undefined && body.snapshot !== null && JSON.stringify(body.snapshot).length > 4096) {
            return sendJson(res, 400, { error: "snapshot is larger than 4KB" });
          }
          const store = loadFavorites(favoritesPath);
          const at = new Date().toISOString();

          if (body.action === "remove") {
            const removed = removeFavorite(store, body.chain, body.contract);
            if (removed) saveFavorites(store, favoritesPath);
            return sendJson(res, 200, { removed });
          }
          if (body.action !== "add" && body.action !== "update") {
            return sendJson(res, 400, { error: "action must be add, update or remove" });
          }
          const favorite = upsertFavorite(
            store,
            {
              chain: body.chain,
              contract: body.contract,
              slug: body.slug,
              name: body.name,
              status: body.status,
              note: body.note,
              snapshot: body.snapshot,
            },
            at
          );
          saveFavorites(store, favoritesPath);
          return sendJson(res, 200, { favorite });
        }
        return sendJson(res, 405, { error: "method not allowed" });
      }

      if (req.method === "GET" && url.pathname === "/healthz") {
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === "GET" && url.pathname === "/") {
        const html = renderDashboard(
          scheduler.rows,
          { generatedAt: new Date().toISOString(), sources: ["local state files"] },
          {
            serve: true,
            favorites: loadFavorites(favoritesPath),
            // The queue is the page's view of the executor: files the two
            // processes share, read here so the browser needs no second origin.
            queue: {
              jobs: listJobs(queueDir, Date.now()).slice(0, 100),
              armed: isArmed(queueDir, Date.now()),
              heartbeat: readHeartbeat(),
              summary: summarizeQueue(listJobs(queueDir, Date.now()), Date.now()),
            },
          }
        );
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        });
        return res.end(html);
      }

      if (req.method === "GET" && url.pathname === "/api/status") {
        return sendJson(res, 200, {
          running: scheduler.status.running,
          lastScanAt: scheduler.status.lastScanAt,
          nextScanAt: scheduler.status.nextScanAt,
          lastError: scheduler.status.lastError,
          chains: scheduler.status.chains,
          cursors: scheduler.status.cursors,
          rowCount: scheduler.status.rowCount,
          openseaKey: (process.env.OPENSEA_API_KEY || "").trim().length > 0 ? "set" : "unset",
          lastReports: scheduler.status.lastReports,
          backfill: scheduler.status.backfill,
          refresh: scheduler.status.refresh,
          calendar: scheduler.status.calendar,
          log: sanitizeLog(scheduler.status.log.slice(-20)),
        });
      }

      if (req.method === "GET" && url.pathname === "/api/rows") {
        const chain = url.searchParams.get("chain");
        const grade = url.searchParams.get("grade");
        const stale = url.searchParams.get("stale"); // "0" hides, "1" shows only stale
        const rows = scheduler.rows.filter(
          (row) =>
            (!chain || row.chain === chain) &&
            (!grade || row.grade === grade) &&
            (stale === null || (stale === "0" ? !row.stale : row.stale))
        );
        return sendJson(res, 200, rows);
      }

      if (req.method === "POST" && url.pathname === "/api/scan") {
        const now = Date.now();
        if (now - lastScanRequest < SCAN_THROTTLE_MS) {
          return sendJson(res, 429, { error: "throttled — try again in a few seconds" });
        }
        lastScanRequest = now;
        await readJsonBody(req).catch(() => ({}));
        const started = await scheduler.tick("manual");
        return sendJson(res, started ? 202 : 409, { started });
      }

      sendJson(res, 404, { error: "not found" });
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
  });
}

export async function runServe(config: ServeConfig): Promise<void> {
  const scheduler = new Scheduler(config);
  scheduler.start();

  const server = createServer({ scheduler, exportsDir: config.exportsDir, statePath: config.statePath });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => resolve());
  });
  console.log(
    `[serve] listening on http://${config.host}:${config.port} — chains ${config.chains.join(",")}, every ${Math.round(config.intervalMs / 60_000)}min, rows ${scheduler.rows.length}`
  );

  await new Promise<void>((resolve) => {
    const shutdown = (signal: string) => {
      console.log(`[serve] ${signal} — shutting down`);
      scheduler.stop();
      server.close(() => resolve());
    };
    process.once("SIGTERM", () => shutdown("SIGTERM"));
    process.once("SIGINT", () => shutdown("SIGINT"));
  });
}
