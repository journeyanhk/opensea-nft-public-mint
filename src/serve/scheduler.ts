// The serve-mode scheduler: one scan -> backfill -> rebuild cycle on a timer,
// with mutual exclusion so a slow scan can never overlap the next tick.
//
// Rows are kept in memory and rebuilt from the four local state files after
// every cycle, so a restart shows data immediately and a manual `POST
// /api/scan` behaves exactly like a timer tick.

import { loadLedger } from "../batch-ledger";
import { runScan, ChainScanReport } from "../scan/scanner";
import { runBackfill, loadBackfill, BackfillSummary } from "../scan/backfill";
import { refreshTargets, RefreshSummary } from "../scan/refresh";
import { DashboardRow, loadDashboardRows, loadHistory } from "../scan/html";
import { loadState } from "../scan/state";
import { ServeConfig } from "./config";

export interface SchedulerStatus {
  running: boolean;
  lastScanAt: string | null;
  nextScanAt: string | null;
  lastError: string | null;
  chains: string[];
  cursors: Record<string, number>;
  log: string[];
  lastReports:
    | { chainKey: string; discovered: number; newContracts: number; candidates: number; audited: number }[]
    | null;
  backfill: BackfillSummary | null;
  refresh: RefreshSummary | null;
  rowCount: number;
}

const LOG_LIMIT = 200;

export class Scheduler {
  rows: DashboardRow[] = [];
  readonly status: SchedulerStatus;

  constructor(private readonly config: ServeConfig) {
    this.status = {
      running: false,
      lastScanAt: null,
      nextScanAt: null,
      lastError: null,
      chains: config.chains,
      cursors: {},
      log: [],
      lastReports: null,
      backfill: null,
      refresh: null,
      rowCount: 0,
    };
  }

  log(message: string): void {
    const line = `${new Date().toISOString()} ${message}`;
    this.status.log.push(line);
    if (this.status.log.length > LOG_LIMIT) this.status.log.splice(0, this.status.log.length - LOG_LIMIT);
    console.log(`[serve] ${message}`);
  }

  start(): void {
    this.rebuildRows();
    this.log(`serve starting — chains ${this.config.chains.join(",")}, every ${Math.round(this.config.intervalMs / 60_000)}min`);
    void this.tick("timer");
    this.timer = setInterval(() => void this.tick("timer"), this.config.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private timer: NodeJS.Timeout | null = null;

  async tick(trigger: "timer" | "manual"): Promise<boolean> {
    if (this.status.running) {
      this.log(`tick(${trigger}) skipped — the previous cycle is still running`);
      return false;
    }
    this.status.running = true;
    this.log(`scan started (${trigger})`);
    try {
      const reports: ChainScanReport[] = await runScan(
        {
          chains: this.config.chains,
          includeMints: this.config.includeMints,
          sinceDays: 1,
          horizonHours: this.config.horizonHours,
          limit: this.config.limit,
          lookbackDays: this.config.lookbackDays,
          audit: true,
          statePath: this.config.statePath,
          historyPath: this.config.historyPath,
          cacheDir: this.config.cacheDir,
        },
        (message) => this.log(message)
      );
      this.status.lastReports = reports.map((report) => ({
        chainKey: report.chainKey,
        discovered: report.discovered,
        newContracts: report.newContracts.length,
        candidates: report.candidates.length,
        audited: report.audited.length,
      }));
      this.log(
        `scan done — ${reports.map((r) => `${r.chainKey}:${r.audited.length} audited`).join(" ")}`
      );

      const ledger = loadLedger(this.config.ledgerPath);
      const backfill = await runBackfill(ledger, {
        ledgerPath: this.config.ledgerPath,
        file: this.config.backfillPath,
      });
      this.status.backfill = backfill;
      if (backfill.due > 0) this.log(`backfill — due ${backfill.due}, written ${backfill.written}`);

      // Drain the refresh backlog from the service itself, a bounded slice per
      // cycle, so a migration needs no stop-the-service window. Disable with
      // REFRESH_PER_TICK=0 and run `--refresh-targets` manually instead.
      if (this.config.refreshPerTick > 0) {
        const refresh = await refreshTargets({
          limit: this.config.refreshPerTick,
          statePath: this.config.statePath,
          onProgress: (message) => this.log(`refresh: ${message}`),
        });
        this.status.refresh = refresh;
        if (refresh.processed > 0) {
          this.log(
            `refresh — processed ${refresh.processed}, socials +${refresh.socialsUpdated}, x +${refresh.xUpdated}, ` +
              `rate-limited ${refresh.rateLimited}, remaining ${refresh.remaining}`
          );
        }
      }

      this.rebuildRows();
      this.status.lastScanAt = new Date().toISOString();
      this.status.lastError = null;
    } catch (err) {
      this.status.lastError = (err as Error).message;
      this.log(`ERROR ${(err as Error).message}`);
    } finally {
      this.status.running = false;
      this.status.nextScanAt = new Date(Date.now() + this.config.intervalMs).toISOString();
      this.refreshCursors();
    }
    return true;
  }

  rebuildRows(): void {
    try {
      const { state } = loadState(this.config.statePath);
      this.rows = loadDashboardRows(
        state,
        loadHistory(this.config.historyPath),
        loadLedger(this.config.ledgerPath),
        undefined,
        loadBackfill(this.config.backfillPath)
      );
      this.status.rowCount = this.rows.length;
    } catch (err) {
      this.log(`rows rebuild failed: ${(err as Error).message}`);
    }
  }

  private refreshCursors(): void {
    try {
      const { state } = loadState(this.config.statePath);
      this.status.cursors = Object.fromEntries(
        Object.entries(state.chains).map(([chain, cursor]) => [chain, cursor.cursorBlock])
      );
    } catch {
      // status is best-effort
    }
  }
}
