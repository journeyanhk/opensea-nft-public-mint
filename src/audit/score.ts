// Target grading — pure functions, no I/O.
//
// Two headroom numbers are graded separately because they answer different
// questions: the upper bound (supply minus minted) is available days ahead, the
// projection (minus the recent mint rate times time-to-public) only once a
// presale is running. Stock Salesman was grade C by the upper bound four hours
// before its public stage, and by the projection at 17:00 — the two paths
// cross-check each other.

export type Grade = "A" | "B" | "C" | "D";

const RANK: Record<Grade, number> = { A: 0, B: 1, C: 2, D: 3 };

export function worseGrade(a: Grade, b: Grade): Grade {
  return RANK[a] >= RANK[b] ? a : b;
}

// --- headroom -------------------------------------------------------------

export interface HeadroomInputs {
  maxSupply: bigint | null; // null when the contract pins no supply
  totalMinted: bigint;
  requested: bigint; // quantity × wallets
  recentTokens: bigint; // tokens minted inside the recent window
  recentWindowMinutes: number;
  minutesToPublic: number; // <= 0 when the public stage is already open
  rateConfident: boolean;
}

export interface HeadroomResult {
  remaining: bigint | null;
  projected: bigint | null;
  upperGrade: Grade;
  projectedGrade: Grade;
  upperReason: string;
  projectedReason: string;
}

export function remainingSupply(maxSupply: bigint | null, totalMinted: bigint): bigint | null {
  if (maxSupply === null || maxSupply <= 0n) return null;
  return maxSupply - totalMinted;
}

export function gradeRemaining(remaining: bigint | null, requested: bigint): Grade {
  if (remaining === null) return "B";
  if (remaining <= 0n) return "C";
  if (remaining < requested) return "B";
  return "A";
}

export function projectedHeadroom(
  remaining: bigint | null,
  recentTokens: bigint,
  recentWindowMinutes: number,
  minutesToPublic: number
): bigint | null {
  if (remaining === null) return null;
  if (minutesToPublic <= 0 || recentWindowMinutes <= 0) return remaining;
  const perMinute = recentTokens / BigInt(Math.max(1, Math.round(recentWindowMinutes)));
  return remaining - perMinute * BigInt(Math.max(0, Math.round(minutesToPublic)));
}

export function gradeProjected(projected: bigint | null, requested: bigint, rateConfident: boolean): Grade {
  if (projected === null) return "B";
  if (projected <= 0n) return rateConfident ? "C" : "B";
  if (projected < requested) return "B";
  return "A";
}

// A rate is only trustworthy with a long enough sample: at least 10 minutes of
// history and 20 tokens minted in the window.
export function isRateConfident(recentTokens: bigint, sampleMinutes: number): boolean {
  return sampleMinutes >= 10 && recentTokens >= 20n;
}

export function headroom(input: HeadroomInputs): HeadroomResult {
  const remaining = remainingSupply(input.maxSupply, input.totalMinted);
  const projected = projectedHeadroom(
    remaining,
    input.recentTokens,
    input.recentWindowMinutes,
    input.minutesToPublic
  );
  const upperGrade = gradeRemaining(remaining, input.requested);
  // Once the stage is open, `remaining` is an observation rather than a
  // projection, so the rate-confidence guard must not soften it.
  const projectedGrade =
    input.minutesToPublic <= 0 ? upperGrade : gradeProjected(projected, input.requested, input.rateConfident);

  return {
    remaining,
    projected,
    upperGrade,
    projectedGrade,
    upperReason:
      remaining === null
        ? "supply not pinned"
        : remaining <= 0n
          ? "all minted (0 left)"
          : `upper bound ${remaining} left`,
    projectedReason:
      projected === null
        ? "supply not pinned"
        : input.minutesToPublic <= 0
          ? `public stage open, ${projected} left`
          : input.rateConfident
            ? `at the last ${input.recentWindowMinutes}m rate, ${projected} expected left`
            : `short rate sample, using ${projected}`,
  };
}

// --- risk -----------------------------------------------------------------

export interface RiskInputs {
  priceChanges: number;
  startChanges: number;
  lastPriceChangeAt: number | null; // unix seconds
  lastStartChangeAt: number | null;
  publicStartAt: number; // unix seconds
  now: number; // unix seconds
  topMinterShare: number; // 0..1
  socialKnown: boolean; // API answered
  socialAny: boolean;
  ageHours: number | null; // collection created → public start
}

export interface RiskResult {
  cap: Grade | null; // hard ceiling applied to the final grade
  labels: string[];
}

export function assessRisk(input: RiskInputs): RiskResult {
  const labels: string[] = [];
  let cap: Grade | null = null;

  const minutesBefore = (at: number | null): number | null =>
    at === null ? null : Math.round((input.publicStartAt - at) / 60);

  const priceMinutes = minutesBefore(input.lastPriceChangeAt);
  if (priceMinutes !== null && priceMinutes >= 0 && priceMinutes <= 60) {
    labels.push(`price changed ${priceMinutes}m before open`);
  }
  const startMinutes = minutesBefore(input.lastStartChangeAt);
  if (startMinutes !== null && startMinutes >= 0 && startMinutes <= 60) {
    labels.push(`start time moved ${startMinutes}m before open`);
  }
  if (input.startChanges >= 3) labels.push(`start time changed ${input.startChanges} times`);
  if (input.priceChanges >= 1 && (priceMinutes === null || priceMinutes > 60)) {
    labels.push(`price changed ${input.priceChanges} times`);
  }
  if (input.topMinterShare >= 0.5) {
    labels.push(`top minter holds ${Math.round(input.topMinterShare * 100)}%`);
  }

  if (input.socialKnown && !input.socialAny) {
    labels.push("no socials");
    if (input.ageHours !== null && input.ageHours < 24) {
      labels.push(`launched ${Math.round(input.ageHours)}h before open`);
      cap = "D";
    }
  }

  return { cap, labels };
}

// --- grading --------------------------------------------------------------

export interface GradeInput extends HeadroomInputs, RiskInputs {}

export interface GradeResult {
  grade: Grade;
  upperGrade: Grade;
  projectedGrade: Grade;
  risks: string[];
  reason: string;
  upperReason: string;
  projectedReason: string;
}

export function gradeTarget(input: GradeInput): GradeResult {
  const h = headroom(input);
  const risk = assessRisk(input);
  const base = worseGrade(h.upperGrade, h.projectedGrade);
  const grade = risk.cap ? worseGrade(base, risk.cap) : base;

  const reasons = [h.projectedReason];
  if (grade === "C") reasons.unshift("public stage likely dry");
  if (grade === "D") reasons.unshift("high-risk signals");
  if (risk.labels.length > 0) reasons.push(risk.labels[0]);

  return {
    grade,
    upperGrade: h.upperGrade,
    projectedGrade: h.projectedGrade,
    risks: risk.labels,
    reason: reasons.join("; "),
    upperReason: h.upperReason,
    projectedReason: h.projectedReason,
  };
}
