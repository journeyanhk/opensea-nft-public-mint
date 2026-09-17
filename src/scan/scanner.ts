// Discovery scanner: watch the SeaDrop singleton, filter what is worth auditing.
//
// Both the config events and the mints come from the same address, so one
// range scan with an OR on topic0 finds every drop that was configured or
// minted from. Discovery is written to the state file before any audit runs,
// and the cursor only advances to `latest - CONFIRMATIONS`, so a crash or a
// reorg cannot lose a drop.

import { resolveChain } from "../chains";
import { planRpcs, resolveRpcsForChain } from "../rpc-resolver";
import { SEADROP_ADDRESS, buildLocalMintPlan, fetchMintStats, PublicDrop } from "../seadrop-public";
import {
  PUBLIC_DROP_UPDATED_TOPIC,
  SEADROP_MINT_TOPIC,
  discoveryWindowBlocks,
  estimateBlockTime,
  scanLogs,
} from "../audit/events";
import { AuditResult, auditTarget } from "../audit/audit";
import { projectedHeadroom, remainingSupply } from "../audit/score";
import {
  ContractEntry,
  DEFAULT_HISTORY_PATH,
  DEFAULT_STATE_PATH,
  ScanState,
  advanceCursor,
  appendHistory,
  loadState,
  recordContracts,
  saveState,
} from "./state";

export const DEFAULT_SCAN_CHAINS = ["robinhood", "arc"];
export const CONFIRMATIONS = 64;
const REAUDIT_MS = 30 * 60_000;
const CANDIDATE_CONCURRENCY = 3;
const RECENT_WINDOW_MINUTES = 15;

// Pending candidates go first so a run that hit --limit does not starve behind
// next run's fresh discoveries.
export function selectAuditBatch(
  pending: string[],
  fresh: string[],
  limit: number
): { audit: string[]; overflow: string[] } {
  const ordered = [...pending, ...fresh];
  return { audit: ordered.slice(0, limit), overflow: ordered.slice(limit) };
}

export function discoveryTopics(): string[] {
  return [PUBLIC_DROP_UPDATED_TOPIC, SEADROP_MINT_TOPIC];
}

export function isCandidateDrop(drop: PublicDrop, nowSec: number, horizonHours: number): boolean {
  if (drop.endTime <= nowSec) return false;
  if (drop.startTime > nowSec + horizonHours * 3600) return false;
  return true;
}

export interface ShouldAuditInput {
  entry: ContractEntry | undefined;
  eventSinceAudit: boolean;
  startAtMs: number | null;
  nowMs: number;
  horizonMs: number;
  reauditMs?: number;
}

export function shouldAudit(input: ShouldAuditInput): boolean {
  const { entry, eventSinceAudit, startAtMs, nowMs, horizonMs } = input;
  const reauditMs = input.reauditMs ?? REAUDIT_MS;
  if (!entry) return true;
  if (entry.soldOutAtBlock !== null && !eventSinceAudit) return false;
  if (eventSinceAudit) return true;
  if (entry.lastAuditedAt === null) return true;
  if (startAtMs !== null && startAtMs > nowMs && startAtMs - nowMs <= horizonMs) {
    return nowMs - Date.parse(entry.lastAuditedAt) > reauditMs;
  }
  return false;
}

interface Skipped {
  ended: number;
  far: number;
  soldOut: number;
  notApplicable: number;
  known: number;
  limited: number; // candidates beyond --limit, left for the next run
}

export interface ChainScanReport {
  chainKey: string;
  fromBlock: number;
  toBlock: number;
  windows: number;
  discovered: number;
  newContracts: string[];
  candidates: string[];
  skipped: Skipped;
  audited: AuditResult[];
}

export interface ScanOptions {
  chains: string[];
  sinceDays: number;
  horizonHours: number;
  limit: number;
  lookbackDays: number;
  audit: boolean;
  statePath?: string;
  historyPath?: string;
  cacheDir?: string;
}

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
}

function decodedContract(log: { topics: string[] }): string | null {
  const topic = log.topics[1];
  return topic && topic.length === 66 ? "0x" + topic.slice(26).toLowerCase() : null;
}

export async function runScan(
  opts: ScanOptions,
  onProgress: (message: string) => void = () => {}
): Promise<ChainScanReport[]> {
  const statePath = opts.statePath ?? DEFAULT_STATE_PATH;
  const historyPath = opts.historyPath ?? DEFAULT_HISTORY_PATH;
  const { state, corrupt } = loadState(statePath);
  if (corrupt) onProgress(`state file ${statePath} was unreadable — starting from empty state`);
  const reports: ChainScanReport[] = [];

  for (const chainKey of opts.chains) {
    const chain = resolveChain(chainKey);
    if (!chain) throw new Error(`Unsupported chain "${chainKey}"`);
    const report: ChainScanReport = {
      chainKey,
      fromBlock: 0,
      toBlock: 0,
      windows: 0,
      discovered: 0,
      newContracts: [],
      candidates: [],
      skipped: { ended: 0, far: 0, soldOut: 0, notApplicable: 0, known: 0, limited: 0 },
      audited: [],
    };
    reports.push(report);

    const { urls } = resolveRpcsForChain(chain.key);
    const rpcPlan = await planRpcs(urls, chain.chainId);
    if (!rpcPlan.verified || rpcPlan.urls.length === 0) {
      onProgress(`${chainKey}: no RPC confirmed chain ID ${chain.chainId} — skipped`);
      continue;
    }
    const rpcUrl = rpcPlan.urls[0];

    const { latestBlock, secondsPerBlock } = await estimateBlockTime(rpcUrl);
    const toBlock = Math.max(0, latestBlock - CONFIRMATIONS);
    const cursor = state.chains[chainKey]?.cursorBlock ?? null;
    const fromBlock =
      cursor !== null && cursor + 1 <= toBlock
        ? cursor + 1
        : cursor !== null
          ? toBlock + 1
          : Math.max(0, toBlock - Math.ceil((opts.sinceDays * 86_400) / secondsPerBlock));

    report.fromBlock = fromBlock;
    report.toBlock = toBlock;
    report.windows =
      fromBlock <= toBlock
        ? Math.ceil((toBlock - fromBlock + 1) / discoveryWindowBlocks(chainKey))
        : 0;

    let seenContracts: string[] = [];
    if (fromBlock <= toBlock) {
      onProgress(`${chainKey}: scanning blocks ${fromBlock}..${toBlock}`);
      const logs = await scanLogs(chainKey, SEADROP_ADDRESS, [discoveryTopics()], fromBlock, toBlock, {
        rpcUrl,
        window: discoveryWindowBlocks(chainKey),
        maxRetries: 8,
        onProgress: (message) => onProgress(`${chainKey}: ${message}`),
      });

      const seen = new Map<string, number>();
      for (const log of logs) {
        const contract = decodedContract(log);
        if (!contract) continue;
        const block = Number(BigInt(log.blockNumber));
        seen.set(contract, Math.max(seen.get(contract) ?? 0, block));
      }

      const at = new Date().toISOString();
      const contracts = [...seen].map(([contract, block]) => ({ contract, block }));
      const added = recordContracts(state, chainKey, contracts, at);
      report.discovered = contracts.length;
      report.newContracts = added;
      seenContracts = contracts.map((c) => c.contract);
      onProgress(`${chainKey}: ${contracts.length} contracts (${added.length} new)`);
    } else {
      onProgress(`${chainKey}: no new blocks since cursor ${cursor}`);
    }

    // Discovery is persisted before any audit runs.
    saveState(state, statePath);

    // Candidate seeds: contracts seen in this window, contracts left pending by
    // an earlier --limit, and known contracts whose public stage is approaching.
    const nowMs = Date.now();
    const horizonMs = opts.horizonHours * 3_600_000;
    const queued = new Set<string>();
    const pendingSeeds: string[] = [];
    const freshSeeds: string[] = [];
    for (const contract of seenContracts) {
      if (!queued.has(contract)) {
        queued.add(contract);
        freshSeeds.push(contract);
      }
    }
    for (const [contract, entry] of Object.entries(state.contracts[chainKey] ?? {})) {
      if (queued.has(contract)) continue;
      if (entry.pendingAudit) {
        queued.add(contract);
        pendingSeeds.push(contract);
        continue;
      }
      if (
        entry.publicStart !== null &&
        entry.publicStart * 1000 > nowMs &&
        entry.publicStart * 1000 - nowMs <= horizonMs
      ) {
        queued.add(contract);
        freshSeeds.push(contract);
      }
    }
    const pendingSet = new Set(pendingSeeds);

    const pendingCandidates: string[] = [];
    const freshCandidates: string[] = [];
    await pool([...pendingSeeds, ...freshSeeds], CANDIDATE_CONCURRENCY, async (contract) => {
      const entry = state.contracts[chainKey][contract];
      const eventSinceAudit =
        entry.lastAuditedBlock === null || entry.lastSeenBlock > entry.lastAuditedBlock;

      // buildLocalMintPlan is the real executability test (drop + resolvable fee
      // recipient), so a drop the batch could never mint is filtered here.
      const plan = await buildLocalMintPlan(rpcUrl, contract, 1);
      if (!plan) {
        report.skipped.notApplicable++;
        delete state.contracts[chainKey][contract];
        return;
      }
      entry.publicStart = plan.drop.startTime;
      const nowSec = Math.floor(nowMs / 1000);
      if (!isCandidateDrop(plan.drop, nowSec, opts.horizonHours)) {
        if (plan.drop.endTime <= nowSec) report.skipped.ended++;
        else report.skipped.far++;
        entry.pendingAudit = false;
        return;
      }

      const stats = await fetchMintStats(rpcUrl, contract, "0x0000000000000000000000000000000000000000");
      if (stats && stats.maxSupply > 0n && stats.totalMinted >= stats.maxSupply) {
        // Mark it processed up to the last event so it is not re-checked until
        // something actually happens again.
        entry.soldOutAtBlock = entry.lastSeenBlock;
        entry.lastAuditedBlock = entry.lastSeenBlock;
        entry.pendingAudit = false;
        report.skipped.soldOut++;
        return;
      }

      if (!shouldAudit({ entry, eventSinceAudit, startAtMs: plan.drop.startTime * 1000, nowMs, horizonMs })) {
        entry.pendingAudit = false;
        report.skipped.known++;
        return;
      }
      (pendingSet.has(contract) ? pendingCandidates : freshCandidates).push(contract);
    });

    const { audit: toAudit, overflow } = selectAuditBatch(pendingCandidates, freshCandidates, opts.limit);
    report.candidates = toAudit;
    report.skipped.limited = overflow.length;
    if (opts.audit) {
      for (const contract of overflow) state.contracts[chainKey][contract].pendingAudit = true;
    }
    saveState(state, statePath);

    if (opts.audit) {
      for (const contract of toAudit) {
        onProgress(`${chainKey}: auditing ${contract}`);
        try {
          const result = await auditTarget(
            { chainKey, target: contract },
            { lookbackDays: opts.lookbackDays, maxRetries: 8, cacheDir: opts.cacheDir }
          );
          report.audited.push(result);
          const entry = state.contracts[chainKey][contract];
          entry.lastAuditedBlock = toBlock;
          entry.lastAuditedAt = new Date().toISOString();
          entry.lastGrade = result.grade.grade;
          entry.publicStart = result.publicDrop?.startTime ?? entry.publicStart;
          entry.pendingAudit = false;
          const remaining = remainingSupply(result.maxSupply, result.totalMinted);
          appendHistory(
            [
              {
                at: entry.lastAuditedAt,
                chain: chainKey,
                contract,
                grade: result.grade.grade,
                remaining: remaining === null ? null : remaining.toString(),
                projected: String(
                  projectedHeadroom(
                    remaining,
                    result.mintScan.recentTokens,
                    RECENT_WINDOW_MINUTES,
                    Math.max(0, ((result.publicDrop?.startTime ?? 0) - Math.floor(Date.now() / 1000)) / 60)
                  )
                ),
                start: result.publicDrop?.startTime ?? null,
              },
            ],
            historyPath
          );
        } catch (err) {
          onProgress(`${chainKey}: audit failed for ${contract}: ${(err as Error).message}`);
        }
      }
    }

    advanceCursor(state, chainKey, toBlock, secondsPerBlock, new Date().toISOString());
    saveState(state, statePath);
  }

  return reports;
}
