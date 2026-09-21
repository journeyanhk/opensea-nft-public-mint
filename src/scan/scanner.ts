// Discovery scanner: watch the SeaDrop singleton, filter what is worth auditing.
//
// Both the config events and the mints come from the same address, so one
// range scan with an OR on topic0 finds every drop that was configured or
// minted from. Discovery is written to the state file before any audit runs,
// and the cursor only advances to `latest - CONFIRMATIONS`, so a crash or a
// reorg cannot lose a drop.

import { resolveChain } from "../chains";
import { planRpcs, resolveScanRpcs } from "../rpc-resolver";
import { SEADROP_ADDRESS, buildLocalMintPlan, fetchMintStats, PublicDrop } from "../seadrop-public";
import {
  PUBLIC_DROP_UPDATED_TOPIC,
  SEADROP_MINT_TOPIC,
  discoveryWindowBlocks,
  estimateBlockTime,
  scanLogs,
} from "../audit/events";
import { AuditResult, auditTarget } from "../audit/audit";
import { CalendarSnapshot, UpsertResult, calendarVerdict, fetchCalendar, upsertCalendar } from "./calendar";
import {
  DEFAULT_SMART_PATH,
  addSmartCandidates,
  loadSmartStore,
  saveSmartStore,
  smartCandidates,
  smartSet,
} from "./smart-minters";
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
// Opened targets that produced nothing twice in a row no longer need 30-minute
// attention; their series is flat and the slots are better spent elsewhere.
const QUIET_REAUDIT_MS = 2 * 60 * 60_000;
// Opened targets keep being re-audited for this long so the dashboard gets a
// minted-over-time series (24h velocity, sell-out ETA).
export const REAUDIT_OPENED_HOURS = 72;
const CANDIDATE_CONCURRENCY = 3;
const RECENT_WINDOW_MINUTES = 15;

// Pending candidates go first so a run that hit --limit does not starve behind
// next run's fresh discoveries.
// New work (backlog + fresh discoveries) is served first so a large population
// of opened targets cannot starve incoming drops; re-audits fill whatever slots
// remain. Overflow here is backlog only — re-audits that miss out are simply
// reconsidered next cycle, ordered by how long ago they were last seen.
export function selectAuditBatch(
  pending: string[],
  fresh: string[],
  limit: number,
  reaudit: string[] = []
): { audit: string[]; overflow: string[] } {
  const core = [...pending, ...fresh];
  const coreTaken = Math.min(core.length, limit);
  const reauditTaken = Math.min(reaudit.length, limit - coreTaken);
  const audit = [...core.slice(0, coreTaken), ...reaudit.slice(0, reauditTaken)];
  const overflow = core.slice(coreTaken);
  return { audit, overflow };
}

// A drop the script can mint always publishes its public schedule, so the config
// event alone discovers it. Mints are an order of magnitude denser and are what
// blew out log ranges; activity for known contracts is checked by the audit
// stage's per-contract (topic1-filtered) scan instead.
export function discoveryTopics(includeMints = false): string[] {
  return includeMints ? [PUBLIC_DROP_UPDATED_TOPIC, SEADROP_MINT_TOPIC] : [PUBLIC_DROP_UPDATED_TOPIC];
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
  quietStreak?: number;
}

export function shouldAudit(input: ShouldAuditInput): boolean {
  const { entry, eventSinceAudit, startAtMs, nowMs, horizonMs } = input;
  const reauditMs = input.reauditMs ?? REAUDIT_MS;
  if (!entry) return true;
  if (entry.soldOutAtBlock !== null && !eventSinceAudit) return false;
  if (eventSinceAudit) return true;
  if (entry.lastAuditedAt === null) return true;

  const sinceAuditMs = nowMs - Date.parse(entry.lastAuditedAt);
  const cadence = (input.quietStreak ?? 0) >= 2 ? QUIET_REAUDIT_MS : reauditMs;
  if (startAtMs !== null && startAtMs <= nowMs && nowMs - startAtMs <= REAUDIT_OPENED_HOURS * 3_600_000) {
    return sinceAuditMs > cadence;
  }
  if (startAtMs !== null && startAtMs > nowMs && startAtMs - nowMs <= horizonMs) {
    return sinceAuditMs > cadence;
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
  includeMints: boolean;
  sinceDays: number;
  horizonHours: number;
  limit: number;
  lookbackDays: number;
  audit: boolean;
  statePath?: string;
  historyPath?: string;
  // Tests inject these; production uses the OpenSea calendar page.
  calendarFn?: () => Promise<CalendarSnapshot>;
  calendarIntervalMs?: number;
  now?: () => Date;
  smartPath?: string;
  smartSet?: Set<string>;
  cacheDir?: string;
}

export interface CalendarUpdate extends UpsertResult {
  counts: Record<string, number>;
  warnings: string[];
}

// Reads the OpenSea calendar at most once per interval and folds it into the
// state. Failure is reported and ignored: the previous snapshot stays, because
// "could not read the calendar" must never look like "the calendar is empty".
export async function refreshCalendar(state: ScanState, opts: CalendarOptions = {}): Promise<CalendarUpdate | null> {
  const now = opts.now?.() ?? new Date();
  const interval = opts.intervalMs ?? Math.max(60_000, (Number(process.env.CALENDAR_INTERVAL_MIN) || 15) * 60_000);
  const last = state.calendar?.fetchedAt ? Date.parse(state.calendar.fetchedAt) : NaN;
  if (Number.isFinite(last) && now.getTime() - last < interval) return null;

  const scoped = opts.chains;
  try {
    const snapshot = await (opts.calendarFn ?? (() => fetchCalendar()))();
    const supported = snapshot.entries.filter(
      (entry) => resolveChain(entry.chain) && (scoped === undefined || scoped.includes(entry.chain))
    );
    const counts: Record<string, number> = {};
    for (const entry of supported) counts[entry.chain] = (counts[entry.chain] ?? 0) + 1;

    // The canary baseline only covers chains we scan, otherwise a chain that is
    // simply not configured would look like a parser regression every run.
    const previous =
      state.calendar?.counts === undefined
        ? null
        : Object.fromEntries(
            Object.entries(state.calendar.counts).filter(([chain]) => scoped === undefined || scoped.includes(chain))
          );
    const { warnings } = calendarVerdict(previous, counts);
    const result = upsertCalendar(state, supported, snapshot.fetchedAt);
    state.calendar = { fetchedAt: snapshot.fetchedAt, counts, warnings };
    opts.onProgress?.(
      `calendar — added ${result.added}, updated ${result.updated}, counts ${Object.entries(counts).map(([chain, n]) => chain + ":" + n).join(" ") || "none"}`
    );
    for (const warning of warnings) opts.onProgress?.(`calendar canary: ${warning}`);
    return { ...result, counts, warnings };
  } catch (err) {
    opts.onProgress?.(`calendar unavailable — ${(err as Error).message}`);
    return null;
  }
}

export interface CalendarOptions {
  calendarFn?: () => Promise<CalendarSnapshot>;
  intervalMs?: number;
  now?: () => Date;
  chains?: string[]; // only these chains land in the state; others are dropped
  onProgress?: (message: string) => void;
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

  // The calendar is chain-agnostic and throttled separately from the scan tick:
  // it gives upcoming targets days of lead time, which is what the board is for.
  const smartFile = opts.smartPath ?? DEFAULT_SMART_PATH;
  const smartStore = loadSmartStore(smartFile);
  const smart = opts.smartSet ?? smartSet(smartStore);
  let smartDirty = false;

  const calendarUpdate = await refreshCalendar(state, {
    calendarFn: opts.calendarFn,
    intervalMs: opts.calendarIntervalMs,
    now: opts.now,
    chains: opts.chains,
    onProgress,
  });
  if (calendarUpdate && (calendarUpdate.added > 0 || calendarUpdate.updated > 0)) saveState(state, statePath);
  try {
    if (smartDirty || smartStore.updatedAt) saveSmartStore(smartStore, smartFile);
  } catch (err) {
    onProgress(`smart-minter store not saved — ${(err as Error).message}`);
  }

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

    const { urls, source } = resolveScanRpcs(chain.key);
    const rpcPlan = await planRpcs(urls, chain.chainId);
    onProgress(`${chainKey}: scan RPCs — ${source}`);
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
        ? Math.ceil((toBlock - fromBlock + 1) / discoveryWindowBlocks(chainKey, opts.includeMints))
        : 0;

    let seenContracts: string[] = [];
    if (fromBlock <= toBlock) {
      onProgress(`${chainKey}: scanning blocks ${fromBlock}..${toBlock}`);
      const logs = await scanLogs(chainKey, SEADROP_ADDRESS, [discoveryTopics(opts.includeMints)], fromBlock, toBlock, {
        rpcUrls: rpcPlan.urls,
        window: discoveryWindowBlocks(chainKey, opts.includeMints),
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
    const reauditCandidates: { contract: string; lastAuditedAt: string | null }[] = [];
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
      entry.endTime = plan.drop.endTime;
      // The plan was fetched to filter this candidate; keeping its facts costs
      // nothing and removes the "price unknown" backlog on the board.
      entry.mintPriceWei = plan.drop.mintPrice.toString();
      entry.capPerWallet = plan.drop.maxTotalMintableByWallet > 0 ? plan.drop.maxTotalMintableByWallet : null;
      entry.feeRecipient = plan.feeRecipient;
      const nowSec = Math.floor(nowMs / 1000);
      if (!isCandidateDrop(plan.drop, nowSec, opts.horizonHours)) {
        if (plan.drop.endTime <= nowSec) report.skipped.ended++;
        else report.skipped.far++;
        entry.pendingAudit = false;
        return;
      }

      const stats = await fetchMintStats(rpcUrl, contract, "0x0000000000000000000000000000000000000000");
      if (stats) {
        entry.maxSupply = stats.maxSupply > 0n ? stats.maxSupply.toString() : null;
        entry.totalMinted = stats.totalMinted.toString();
      }
      if (stats && stats.maxSupply > 0n && stats.totalMinted >= stats.maxSupply) {
        // Mark it processed up to the last event so it is not re-checked until
        // something actually happens again.
        entry.soldOutAtBlock = entry.lastSeenBlock;
        entry.lastAuditedBlock = entry.lastSeenBlock;
        entry.pendingAudit = false;
        report.skipped.soldOut++;
        return;
      }

      if (
        !shouldAudit({
          entry,
          eventSinceAudit,
          startAtMs: plan.drop.startTime * 1000,
          nowMs,
          horizonMs,
          quietStreak: entry.quietStreak,
        })
      ) {
        entry.pendingAudit = false;
        report.skipped.known++;
        return;
      }
      const openedAtMs = plan.drop.startTime * 1000;
      const openedRecently = openedAtMs <= nowMs && nowMs - openedAtMs <= REAUDIT_OPENED_HOURS * 3_600_000;
      if (pendingSet.has(contract)) pendingCandidates.push(contract);
      else if (openedRecently) reauditCandidates.push({ contract, lastAuditedAt: entry.lastAuditedAt });
      else freshCandidates.push(contract);
    });

    // Least recently audited opened targets first, so the velocity series stays
    // as continuous as --limit allows.
    reauditCandidates.sort((a, b) => String(a.lastAuditedAt).localeCompare(String(b.lastAuditedAt)));
    const { audit: toAudit, overflow } = selectAuditBatch(
      pendingCandidates,
      freshCandidates,
      opts.limit,
      reauditCandidates.map((c) => c.contract)
    );
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
            { lookbackDays: opts.lookbackDays, maxRetries: 8, cacheDir: opts.cacheDir, smartSet: smart }
          );
          report.audited.push(result);
          const entry = state.contracts[chainKey][contract];
          entry.lastAuditedBlock = toBlock;
          entry.lastAuditedAt = new Date().toISOString();
          entry.lastGrade = result.grade.grade;
          entry.publicStart = result.publicDrop?.startTime ?? entry.publicStart;
          entry.endTime = result.publicDrop?.endTime ?? entry.endTime;
          entry.maxSupply = result.maxSupply?.toString() ?? entry.maxSupply;
          entry.totalMinted = result.totalMinted.toString();
          entry.slug = result.slug ?? entry.slug;
          entry.name = result.name ?? entry.name;
          entry.owner = result.owner ?? entry.owner;
          entry.codeHash = result.codeHash ?? entry.codeHash;
          if (result.social) {
            entry.imageUrl = result.social.imageUrl ?? entry.imageUrl;
            entry.twitter = result.social.twitter ?? entry.twitter;
            entry.discord = result.social.discord ?? entry.discord;
            entry.website = result.social.website ?? entry.website;
            entry.createdDate = result.social.createdDate ?? entry.createdDate;
            entry.safelist = result.social.safelist ?? entry.safelist;
            entry.socialCheckedAt = entry.socialCheckedAt ?? entry.lastAuditedAt;
          }
          entry.pendingAudit = false;
          // Sold-out drops are where the winners reveal themselves: whichever
          // wallets filled the cap become candidates for the smart set.
          const soldOutNow =
            result.maxSupply !== null && result.maxSupply > 0n && result.totalMinted >= result.maxSupply;
          if (soldOutNow) {
            const candidates = smartCandidates(
              result.mintScan.topMinters,
              result.publicDrop?.maxTotalMintableByWallet ?? null
            );
            if (candidates.length > 0) {
              addSmartCandidates(smartStore, candidates, `${chainKey}|${contract.toLowerCase()}`, entry.lastAuditedAt ?? new Date().toISOString());
              for (const address of candidates) smart.add(address);
              smartDirty = true;
            }
          }
          const mintedNow = result.totalMinted.toString();
          entry.quietStreak = entry.lastMintedTotal === mintedNow ? (entry.quietStreak ?? 0) + 1 : 0;
          entry.lastMintedTotal = mintedNow;
          const remaining = remainingSupply(result.maxSupply, result.totalMinted);
          appendHistory(
            [
              {
                at: entry.lastAuditedAt,
                chain: chainKey,
                contract,
                grade: result.grade.grade,
                risks: result.grade.risks,
                reason: result.grade.reason,
                coverage: result.scanCoverage,
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
                // Facts below are already read by the auditor; persisting them is
                // what lets the dashboard show "worth it" instead of just "in stock".
                slug: result.slug,
                name: result.name,
                owner: result.owner,
                mintPriceWei: result.publicDrop?.mintPrice?.toString() ?? null,
                capPerWallet: result.publicDrop?.maxTotalMintableByWallet ?? null,
                endTime: result.publicDrop?.endTime ?? null,
                maxSupply: result.maxSupply?.toString() ?? null,
                totalMinted: result.totalMinted.toString(),
                recent15m: (result.mintScan.recentByWindow["15m"] ?? result.mintScan.recentTokens).toString(),
                recent1h: result.mintScan.recentByWindow["1h"]?.toString() ?? null,
                uniqueMinters: result.mintScan.uniqueMinters,
                topMinterShare: result.mintScan.topMinterShare,
                stageCount: result.mintScan.stages.length,
                presaleStages: result.mintScan.stages.filter((stage) => stage.stage !== 0).length,
                maxTxTokens: result.mintScan.maxTxTokens.toString(),
                payerDiffers: result.mintScan.payerDiffers,
                smartMinters: result.smartMinters,
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
