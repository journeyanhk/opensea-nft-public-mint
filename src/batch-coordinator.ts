// Wallet lanes: the scheduling half of "many targets, few wallets".
//
// A wallet is a single serial resource — its nonce is a counter and two
// transactions from it must not race each other. Different wallets are
// independent, which is where the parallelism comes from. This module keeps
// that bookkeeping pure so the policy (who waits, who conflicts, what to
// reserve) is testable without a chain, and wallet-lock.ts adds the
// cross-process guard that stops two processes from sharing a wallet.

export interface LaneState {
  wallet: string;
  owner: string | null;
  leasedUntilMs: number | null;
  reservedWei: bigint; // total across every job's claim
  claims: Record<string, bigint>; // jobId -> worst-case spend
}

export interface AcquireRequest {
  jobId: string;
  wallet: string;
  nowMs: number;
  leaseMs?: number;
}

export interface AcquireResult {
  ok: boolean;
  reason?: string;
  leasedUntilMs?: number;
}

// Worst-case money a job can spend from one wallet: every shot pays gas, and
// with overshoot allowed every shot can also land and pay the mint value.
export function planReservation(input: {
  value: bigint;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  shots?: number;
  overshoot?: boolean;
}): bigint {
  const shots = BigInt(Math.max(1, input.shots ?? 1));
  const valueMultiplier = input.overshoot ? shots : 1n;
  return input.value * valueMultiplier + input.gasLimit * input.maxFeePerGas * shots;
}

const DEFAULT_LEASE_MS = 60_000;

function emptyLane(wallet: string): LaneState {
  return { wallet, owner: null, leasedUntilMs: null, reservedWei: 0n, claims: {} };
}

export class LaneCoordinator {
  private lanes = new Map<string, LaneState>();

  private laneOf(wallet: string): LaneState {
    const key = wallet.toLowerCase();
    const lane = this.lanes.get(key) ?? emptyLane(key);
    this.lanes.set(key, lane);
    return lane;
  }

  // The lane is the *send* phase's exclusive resource; money is tracked
  // separately by reserve()/unreserve(), because a job that is merely queued has
  // already committed its worst-case spend.
  acquire(request: AcquireRequest): AcquireResult {
    const now = request.nowMs;
    const lane = this.laneOf(request.wallet);
    if (lane.owner !== null && lane.leasedUntilMs !== null && lane.leasedUntilMs > now) {
      return { ok: false, reason: `wallet ${lane.wallet} is busy with ${lane.owner} until ${lane.leasedUntilMs}` };
    }
    const leasedUntilMs = now + (request.leaseMs ?? DEFAULT_LEASE_MS);
    lane.owner = request.jobId;
    lane.leasedUntilMs = leasedUntilMs;
    return { ok: true, leasedUntilMs };
  }

  // A task waiting on receipts can take far longer than one lease. Renewing is
  // how it proves it is still alive; expire() then only recovers crashes.
  renew(request: { wallet: string; jobId: string; nowMs: number; leaseMs?: number }): boolean {
    const lane = this.laneOf(request.wallet);
    if (lane.owner !== request.jobId) return false;
    lane.leasedUntilMs = request.nowMs + (request.leaseMs ?? DEFAULT_LEASE_MS);
    return true;
  }

  // Only the owner can release: a job that finished must not free a lane that a
  // different job has already taken over after a lease expiry.
  release(wallet: string, jobId: string): boolean {
    const lane = this.laneOf(wallet);
    if (lane.owner !== jobId) return false;
    lane.owner = null;
    lane.leasedUntilMs = null;
    return true;
  }

  // Crash safety: an owner that stopped renewing is gone, so its lane frees
  // itself. A live holder that renews is never preempted.
  expire(nowMs: number): string[] {
    const freed: string[] = [];
    for (const lane of this.lanes.values()) {
      if (lane.owner !== null && lane.leasedUntilMs !== null && lane.leasedUntilMs <= nowMs) {
        lane.owner = null;
        lane.leasedUntilMs = null;
        freed.push(lane.wallet);
      }
    }
    return freed;
  }

  // Cumulative per job: merging a third target into a watched batch must see
  // what the first two already committed, not overwrite it.
  reserve(request: { jobId: string; wallet: string; wei: bigint; limitWei?: bigint }): {
    ok: boolean;
    reason?: string;
    shortfallWei?: bigint;
  } {
    const lane = this.laneOf(request.wallet);
    const current = lane.claims[request.jobId] ?? 0n;
    const total = lane.reservedWei - current + request.wei;
    if (request.limitWei !== undefined && total > request.limitWei) {
      return {
        ok: false,
        reason: `wallet ${lane.wallet} would have ${total} reserved against a limit of ${request.limitWei}`,
        shortfallWei: total - request.limitWei,
      };
    }
    lane.claims[request.jobId] = request.wei;
    lane.reservedWei = total;
    return { ok: true };
  }

  unreserve(request: { jobId: string; wallet: string }): bigint {
    const lane = this.laneOf(request.wallet);
    const current = lane.claims[request.jobId] ?? 0n;
    if (current === 0n) return 0n;
    delete lane.claims[request.jobId];
    lane.reservedWei -= current;
    return current;
  }

  reservedTotal(wallet: string): bigint {
    return this.laneOf(wallet).reservedWei;
  }

  reservedBy(wallet: string): Record<string, bigint> {
    return { ...this.laneOf(wallet).claims };
  }

  snapshot(): LaneState[] {
    return [...this.lanes.values()].map((lane) => ({ ...lane, claims: { ...lane.claims } }));
  }
}

export interface ScheduledJob {
  id: string;
  wallets: string[];
  startMs: number;
  priority?: number;
}

export interface LaneLease {
  release: () => void;
  waitedMs: number;
}

// Take every wallet this job needs, or none of them: a half-held set would let
// another job start preparing against a wallet we are about to use. On failure
// the lanes grabbed in that round are handed back and we retry, so two jobs
// sharing a wallet are serialised exactly where it matters (the send), while
// their preparation overlaps.
export async function acquireLanes(input: {
  coordinator: LaneCoordinator;
  jobId: string;
  wallets: string[];
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  leaseMs?: number;
  renewEveryMs?: number;
  retryMs?: number;
  startRenewals?: boolean;
  onWait?: (waiting: string[], waitedMs: number) => void;
}): Promise<LaneLease> {
  const now = input.now ?? (() => Date.now());
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const retryMs = input.retryMs ?? 250;
  const leaseMs = input.leaseMs ?? 60_000;
  const startedAt = now();

  for (;;) {
    // Recover any lane whose owner stopped renewing before deciding we are blocked.
    input.coordinator.expire(now());
    const grabbed: string[] = [];
    let waiting: string[] = [];
    for (const wallet of input.wallets) {
      const result = input.coordinator.acquire({ jobId: input.jobId, wallet, nowMs: now(), leaseMs });
      if (result.ok) grabbed.push(wallet);
      else waiting.push(wallet);
    }
    if (waiting.length === 0) {
      const renewEvery = input.renewEveryMs ?? 10_000;
      const timer =
        input.startRenewals === false
          ? null
          : setInterval(() => {
              for (const wallet of input.wallets) {
                input.coordinator.renew({ wallet, jobId: input.jobId, nowMs: now(), leaseMs });
              }
            }, renewEvery);
      // A lease timer must never keep the process alive on its own.
      (timer as NodeJS.Timeout | null)?.unref?.();
      let released = false;
      return {
        waitedMs: now() - startedAt,
        release: () => {
          if (released) return;
          released = true;
          if (timer) clearInterval(timer);
          for (const wallet of input.wallets) input.coordinator.release(wallet, input.jobId);
        },
      };
    }
    for (const wallet of grabbed) input.coordinator.release(wallet, input.jobId);
    input.onWait?.(waiting, now() - startedAt);
    await sleep(retryMs);
  }
}

// Ordering is by start time; priority only breaks ties (two targets opening at
// the same moment). A conflict is two jobs sharing a wallet within the window —
// the runner warns about those because the second one will have to wait.
export function orderJobs(
  jobs: ScheduledJob[],
  windowMs = 5_000
): { order: string[]; conflicts: { wallet: string; jobs: [string, string] }[] } {
  const sorted = [...jobs].sort(
    (a, b) => a.startMs - b.startMs || (b.priority ?? 0) - (a.priority ?? 0) || a.id.localeCompare(b.id)
  );
  const conflicts: { wallet: string; jobs: [string, string] }[] = [];
  for (const wallet of new Set(jobs.flatMap((job) => job.wallets.map((entry) => entry.toLowerCase())))) {
    const sharing = sorted.filter((job) => job.wallets.some((entry) => entry.toLowerCase() === wallet));
    for (let i = 0; i + 1 < sharing.length; i++) {
      if (Math.abs(sharing[i + 1].startMs - sharing[i].startMs) <= windowMs) {
        conflicts.push({ wallet, jobs: [sharing[i].id, sharing[i + 1].id] });
      }
    }
  }
  return { order: sorted.map((job) => job.id), conflicts };
}
