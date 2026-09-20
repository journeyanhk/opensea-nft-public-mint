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
  reservedWei: bigint;
  leasedUntilMs: number | null;
}

export interface AcquireRequest {
  jobId: string;
  wallet: string;
  reserveWei: bigint;
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

export class LaneCoordinator {
  private lanes = new Map<string, LaneState>();

  acquire(request: AcquireRequest): AcquireResult {
    const wallet = request.wallet.toLowerCase();
    const now = request.nowMs;
    const lane = this.lanes.get(wallet);
    if (lane && lane.owner !== null && lane.leasedUntilMs !== null && lane.leasedUntilMs > now) {
      return { ok: false, reason: `wallet ${wallet} is busy with ${lane.owner} until ${lane.leasedUntilMs}` };
    }
    const leasedUntilMs = now + (request.leaseMs ?? DEFAULT_LEASE_MS);
    this.lanes.set(wallet, { wallet, owner: request.jobId, reservedWei: request.reserveWei, leasedUntilMs });
    return { ok: true, leasedUntilMs };
  }

  // Only the owner can release: a job that finished must not free a lane that a
  // different job has already taken over after a lease expiry.
  release(wallet: string, jobId: string): boolean {
    const key = wallet.toLowerCase();
    const lane = this.lanes.get(key);
    if (!lane || lane.owner !== jobId) return false;
    this.lanes.set(key, { wallet: key, owner: null, reservedWei: 0n, leasedUntilMs: null });
    return true;
  }

  // Crash safety: an expired lease frees itself, so a killed process cannot
  // block a wallet forever.
  expire(nowMs: number): string[] {
    const freed: string[] = [];
    for (const [wallet, lane] of this.lanes) {
      if (lane.owner !== null && lane.leasedUntilMs !== null && lane.leasedUntilMs <= nowMs) {
        this.lanes.set(wallet, { wallet, owner: null, reservedWei: 0n, leasedUntilMs: null });
        freed.push(wallet);
      }
    }
    return freed;
  }

  snapshot(): LaneState[] {
    return [...this.lanes.values()];
  }
}

export interface ScheduledJob {
  id: string;
  wallets: string[];
  startMs: number;
  priority?: number;
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
