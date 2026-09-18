// The serve-mode HTTP surface. Node's built-in http is enough: a handful of
// routes, no static assets (the dashboard is one inline-HTML document) and no
// WebSocket (the status bar polls every 15s).
//
// State-changing requests must be `content-type: application/json` and
// same-origin. A cross-site HTML form cannot send that content type, and we
// return no CORS headers, so this closes the CSRF gap that basic-auth alone
// leaves open.

import http from "http";
import { maskRpc } from "../rpc-resolver";
import { renderDashboard } from "../scan/html";
import { ServeConfig } from "./config";
import { Scheduler } from "./scheduler";

const MAX_BODY_BYTES = 64 * 1024;
const SCAN_THROTTLE_MS = 5_000;

export interface ServerOptions {
  scheduler: Scheduler;
  exportsDir: string;
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

export function createServer(options: ServerOptions): http.Server {
  const { scheduler } = options;
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

      if (req.method === "GET" && url.pathname === "/healthz") {
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === "GET" && url.pathname === "/") {
        const html = renderDashboard(
          scheduler.rows,
          { generatedAt: new Date().toISOString(), sources: ["local state files"] },
          { serve: true }
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

  const server = createServer({ scheduler, exportsDir: config.exportsDir });
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
