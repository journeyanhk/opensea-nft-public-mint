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

export interface BurstPolicyInput {
  count: number;
  capPerWallet: number | null;
  allowOvershoot: boolean;
  clockSkewMs: number;
  leadMs: number;
  forceClock?: boolean;
}

// The rules that decide whether a burst is allowed at all:
//   - one shot is not a burst, and more than BURST_MAX is a spending accident
//   - a per-wallet cap of 1 means only one shot can land; a higher (or unknown)
//     cap could land several, so it needs an explicit opt-in
//   - a clock we do not trust cannot be used to time anything
export function burstGate(input: BurstPolicyInput): { allowed: boolean; reason: string } {
  if (input.count < 2) return { allowed: false, reason: "a burst of one is just a send" };
  if (input.count > BURST_MAX) return { allowed: false, reason: `a burst of ${input.count} exceeds the ${BURST_MAX}-shot bound` };
  if (input.leadMs < 50) return { allowed: false, reason: "a lead below 50ms cannot absorb a round trip" };
  if (input.clockSkewMs > 500 && !input.forceClock) {
    return { allowed: false, reason: `the local clock is ${Math.round(input.clockSkewMs)}ms off the chain — refusing to time a burst` };
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
  return { allowed: true, reason: cap === 1 ? "cap 1: only one shot can land" : "overshoot explicitly allowed" };
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
}

export interface LeadCalibration {
  leadMs: number;
  rttMs: number;
  clockSkewMs: number;
  suspectClock: boolean;
}

const MARGIN_MS = 50;
const SUSPECT_SKEW_MS = 500;

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

// lead = p50 round trip + how far the local clock is behind/ahead of the chain
// + a small margin. The block timestamp is only second-granular, so the skew
// estimate is coarse — which is why burstGate refuses anything past 500ms.
export async function calibrateLead(deps: CalibrateDeps): Promise<LeadCalibration> {
  const now = deps.now ?? (() => Date.now());
  const fetchFn = deps.fetchFn ?? ((url: string, init: RequestInit) => fetch(url, init));
  const url = deps.rpcUrls[0];
  const rttMs = Math.round(await measureRttMs(url, deps));

  let clockSkewMs = 0;
  try {
    const response = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "eth_getBlockByNumber", params: ["latest", false], id: 1 }),
    });
    const json = (await response.json()) as { result?: { timestamp?: string } };
    const timestampSec = Number(json?.result?.timestamp ?? "0x0");
    if (Number.isFinite(timestampSec) && timestampSec > 0) {
      // The block is, on average, half a round trip old when it reaches us.
      clockSkewMs = Math.round(now() - (timestampSec * 1000 + rttMs / 2));
    }
  } catch {
    // no block time: fall back to RTT + margin only
  }

  const leadMs = Math.max(MARGIN_MS, rttMs + Math.max(0, clockSkewMs) + MARGIN_MS);
  return { leadMs, rttMs, clockSkewMs, suspectClock: Math.abs(clockSkewMs) > SUSPECT_SKEW_MS };
}
