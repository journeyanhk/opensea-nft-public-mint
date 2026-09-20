// Burst: several transactions with consecutive nonces, sent a few dozen
// milliseconds before the stage opens, so that one of them is already sitting
// in the sequencer's queue when the contract starts accepting mints.
//
// The evidence behind it: on The Obscura the remaining 1,802 tokens were gone
// in four blocks (~0.4s) and our single transaction, sent 3ms after the open,
// landed in block five. Arrival time, not tip, decided it — the sequencer
// orders by arrival. A burst buys arrival by paying a little gas for shots that
// are expected to revert (NotActive before the open, cap exceeded after).
//
// Everything here is pure or injectable: the policy decisions are testable
// without a chain, and the expensive mistakes (overshoot, a lying clock) are
// refused before anything is signed.

export interface MinterTokenShot {
  txHash: string;
  status: string;
  mintedCount: number;
  tokenIds?: string[];
  gasBurnedWei?: string;
}

export const BURST_MAX = 5;

export function planBurst(baseNonce: number, count: number): number[] {
  return Array.from({ length: Math.max(0, count) }, (_, index) => baseNonce + index);
}

// A hole in the nonce sequence blocks every later transaction from that wallet,
// including the next target's. Reverts spend the nonce, so a hole can only come
// from a transport-level rejection; a zero-value self-transfer with the missing
// nonce is the cheapest way to fill it.
export function gapFillerTx(input: {
  wallet: string;
  nonce: number;
  gasLimit: number;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  chainId: bigint;
}): {
  to: string;
  data: string;
  value: bigint;
  nonce: number;
  gasLimit: number;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  type: 2;
  chainId: bigint;
} {
  return {
    to: input.wallet,
    data: "0x",
    value: 0n,
    nonce: input.nonce,
    gasLimit: input.gasLimit,
    maxFeePerGas: input.maxFeePerGas,
    maxPriorityFeePerGas: input.maxPriorityFeePerGas,
    type: 2,
    chainId: input.chainId,
  };
}

export interface BurstPolicyInput {
  count: number;
  capPerWallet: number | null;
  allowOvershoot: boolean;
  // null = the boundary could not be observed; an unmeasurable clock is not a
  // reason to refuse (the lead then rests on RTT + margin alone).
  clockSkewMs: number | null;
  leadMs: number;
  forceClock?: boolean;
}

// The rules that decide whether a burst is allowed at all:
//   - one shot is not a burst, and more than BURST_MAX is a spending accident
//   - a per-wallet cap of 1 means only one shot can land; a higher (or unknown)
//     cap could land several, so it needs an explicit opt-in
//   - a clock we measured to be wrong cannot time anything
export function burstGate(input: BurstPolicyInput): { allowed: boolean; reason: string } {
  if (input.count < 2) return { allowed: false, reason: "a burst of one is just a send" };
  if (input.count > BURST_MAX) return { allowed: false, reason: `a burst of ${input.count} exceeds the ${BURST_MAX}-shot bound` };
  if (input.leadMs < 50) return { allowed: false, reason: "a lead below 50ms cannot absorb a round trip" };
  if (input.clockSkewMs !== null && input.clockSkewMs > 500 && !input.forceClock) {
    return {
      allowed: false,
      reason: `the local clock is ${Math.round(input.clockSkewMs)}ms off the chain — refusing to time a burst`,
    };
  }
  const cap = input.capPerWallet;
  if (cap === null || cap > 1) {
    if (!input.allowOvershoot) {
      return {
        allowed: false,
        reason: "the per-wallet cap allows more than one shot to land; pass --allow-overshoot to accept buying more than intended",
      };
    }
  }
  const reason = cap === 1 ? "cap 1: only one shot can land" : "overshoot explicitly allowed";
  return { allowed: true, reason: input.clockSkewMs === null ? `${reason}; clock skew unknown (rtt + margin only)` : reason };
}

// One wallet's burst collapses to the shot that landed; every shot's gas is
// still counted, because expected reverts are not free.
export function aggregateBurst(shots: MinterTokenShot[]): {
  status: string;
  mintedCount: number;
  tokenIds: string[];
  txHash: string | null;
  gasBurnedWei: string;
  txHashes: string[];
} {
  const winner = shots.find((shot) => (shot.mintedCount ?? 0) > 0) ?? null;
  const status = winner
    ? winner.status
    : shots.some((shot) => shot.status === "NO_MINT")
      ? "NO_MINT"
      : shots.some((shot) => shot.status === "TIMEOUT")
        ? "TIMEOUT"
        : "REVERTED";
  const gasBurnedWei = shots
    .reduce((sum, shot) => sum + BigInt(shot.gasBurnedWei ?? "0"), 0n)
    .toString();
  return {
    status,
    mintedCount: winner?.mintedCount ?? 0,
    tokenIds: winner?.tokenIds ?? [],
    txHash: winner?.txHash ?? null,
    gasBurnedWei,
    txHashes: shots.map((shot) => shot.txHash),
  };
}

export interface CalibrateDeps {
  rpcUrls: string[];
  now?: () => number;
  rounds?: number;
  measureRtt?: (url: string) => Promise<number>;
  fetchFn?: (url: string, init: RequestInit) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number; // how long to watch for a second boundary (default 3000)
  sampleMs?: number; // poll interval while watching (default 50)
}

export interface LeadCalibration {
  leadMs: number;
  rttMs: number;
  clockSkewMs: number | null; // null = no boundary was observed
  blockIntervalMs: number | null;
  suspectClock: boolean;
}

const MARGIN_MS = 50;
const SUSPECT_SKEW_MS = 500;
const INTERVAL_SAMPLE_MS = 1_200;

async function measureRttMs(url: string, deps: CalibrateDeps): Promise<number> {
  if (deps.measureRtt) return deps.measureRtt(url);
  const now = deps.now ?? (() => Date.now());
  const fetchFn = deps.fetchFn ?? ((target: string, init: RequestInit) => fetch(target, init));
  const samples: number[] = [];
  for (let i = 0; i < Math.max(1, deps.rounds ?? 5); i++) {
    const started = now();
    try {
      await fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "eth_blockNumber", params: [], id: 1 }),
      });
      samples.push(now() - started);
    } catch {
      // a failed probe simply does not contribute a sample
    }
  }
  if (samples.length === 0) return 0;
  samples.sort((a, b) => a - b);
  return samples[Math.floor((samples.length - 1) / 2)];
}

interface RpcProbe {
  blockNumber: () => Promise<number | null>;
  blockTime: () => Promise<number | null>;
}

function makeProbe(deps: CalibrateDeps, url: string): RpcProbe {
  const fetchFn = deps.fetchFn ?? ((target: string, init: RequestInit) => fetch(target, init));
  const call = async (method: string, params: unknown[]): Promise<unknown> => {
    try {
      const response = await fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
      });
      const json = (await response.json()) as { result?: unknown };
      return json?.result ?? null;
    } catch {
      return null;
    }
  };
  return {
    blockNumber: async () => {
      const result = await call("eth_blockNumber", []);
      if (typeof result !== "string") return null;
      const value = Number(BigInt(result));
      return Number.isFinite(value) ? value : null;
    },
    blockTime: async () => {
      const result = await call("eth_getBlockByNumber", ["latest", false]);
      const timestamp = Number((result as { timestamp?: string } | null)?.timestamp ?? "0x0");
      return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
    },
  };
}

// Robinhood produces ~0.1s blocks but EVM timestamps are whole seconds, so the
// real block time is up to 999ms later than the number in the block. Subtracting
// a truncated timestamp from a local clock therefore reads +0..1000ms of pure
// truncation error — enough to trip the 500ms gate half the time.
//
// Instead, watch for the moment the timestamp steps from T to T+1: the chain's
// second boundary happened about one round trip plus half a block interval
// before we saw it, which gives a ±100ms estimate.
async function observeBoundary(
  probe: RpcProbe,
  deps: CalibrateDeps,
  rttMs: number,
  blockIntervalMs: number | null
): Promise<number | null> {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = deps.timeoutMs ?? 3_000;
  const sampleMs = Math.max(10, deps.sampleMs ?? 50);

  const startTs = await probe.blockTime();
  if (startTs === null) return null;
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    await sleep(sampleMs);
    const ts = await probe.blockTime();
    if (ts === null) continue;
    if (ts === startTs + 1) {
      const boundaryLocalMs = now() - rttMs / 2 - (blockIntervalMs ?? 0) / 2;
      return Math.round(boundaryLocalMs - ts * 1000);
    }
    if (ts !== startTs) return null; // jumped further than one second: too slow to be useful
  }
  return null;
}

async function measureBlockIntervalMs(probe: RpcProbe, deps: CalibrateDeps): Promise<number | null> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => Date.now());
  const first = await probe.blockNumber();
  const startedAt = now();
  await sleep(INTERVAL_SAMPLE_MS);
  const second = await probe.blockNumber();
  const finishedAt = now();
  if (first === null || second === null || second <= first) return null;
  const interval = (finishedAt - startedAt) / (second - first);
  return interval > 0 && interval < 60_000 ? interval : null;
}

export async function calibrateLead(deps: CalibrateDeps): Promise<LeadCalibration> {
  const url = deps.rpcUrls[0];
  const probe = makeProbe(deps, url);
  const rttMs = Math.round(await measureRttMs(url, deps));
  const blockIntervalMs = await measureBlockIntervalMs(probe, deps);
  const clockSkewMs = await observeBoundary(probe, deps, rttMs, blockIntervalMs);

  // No skew term when it is unknown: a guess must not silently move the fire
  // time, and the gate reports the unknown instead of refusing.
  const leadMs = Math.max(MARGIN_MS, rttMs + Math.max(0, clockSkewMs ?? 0) + MARGIN_MS);
  return {
    leadMs,
    rttMs,
    clockSkewMs,
    blockIntervalMs,
    suspectClock: clockSkewMs !== null && Math.abs(clockSkewMs) > SUSPECT_SKEW_MS,
  };
}
