// Score "is this worth minting": the view layer's judgement is split from the
// audit's "can I mint it". Everything here is pure so the weights and the
// confidence model are testable without a chain, a key or a network.
//
// Two rules keep the score honest:
//   - a dimension with no data is *excluded*, never scored neutral;
//   - confidence is the share of weight that had data, so a high score on thin
//     data is visibly thin.
//
// Weights are empirical and expected to be tuned once M5a has run for a few days.

import { entryOf, Ledger } from "../batch-ledger";
import { BackfillRecord } from "./backfill";

export type Phase = "upcoming" | "live-fresh" | "live" | "stale" | "sold-out" | "ended" | "unaudited";

export interface SocialFact {
  twitter: string | null;
  discord: string | null;
  website: string | null;
  createdDate: string | null;
  safelist: string | null;
}

export interface CreatorFact {
  owner: string;
  chain: string;
  contract: string;
  soldOut: boolean;
  maxSupply: bigint | null;
  minted: bigint | null;
  velocity24h: bigint | null;
}

export interface CreatorStats {
  owner: string;
  dropCount: number;
  soldOutRate: number | null; // over drops with a known supply
  avgVelocity24h: number | null; // tokens/day, over drops with a reading
  salesCount: number | null; // secondary sales we observed (backfill)
  ownMints: number; // our confirmed mints (ledger)
  ownNetUsd: number | null; // latest net per contract, summed
  ownData: boolean;
}

// Latest observation per contract: a 6h checkpoint supersedes a 1h one.
function latestByContract(records: BackfillRecord[]): Map<string, BackfillRecord> {
  const latest = new Map<string, BackfillRecord>();
  for (const record of records) {
    const key = `${record.chain}|${record.contract.toLowerCase()}`;
    const current = latest.get(key);
    if (!current || record.checkpointHours >= current.checkpointHours) latest.set(key, record);
  }
  return latest;
}

export function creatorStatsFor(
  owner: string,
  facts: CreatorFact[],
  backfills: BackfillRecord[] = [],
  ledger?: Ledger,
  exclude?: { chain: string; contract: string }
): CreatorStats | null {
  const key = (owner || "").trim().toLowerCase();
  if (!key) return null;
  const excluded = exclude ? `${exclude.chain}|${exclude.contract.toLowerCase()}` : null;
  const drops = facts.filter(
    (fact) => (fact.owner ?? "").trim().toLowerCase() === key && `${fact.chain}|${fact.contract.toLowerCase()}` !== excluded
  );
  if (drops.length === 0) return null;
  return statsForOwner(key, drops, latestByContract(backfills), ledger);
}

export function aggregateCreators(
  facts: CreatorFact[],
  backfills: BackfillRecord[] = [],
  ledger?: Ledger
): Map<string, CreatorStats> {
  const owners = new Set(facts.map((fact) => (fact.owner ?? "").trim().toLowerCase()).filter(Boolean));
  const stats = new Map<string, CreatorStats>();
  for (const owner of owners) {
    const value = creatorStatsFor(owner, facts, backfills, ledger);
    if (value) stats.set(owner, value);
  }
  return stats;
}

function statsForOwner(
  owner: string,
  drops: CreatorFact[],
  latest: Map<string, BackfillRecord>,
  ledger?: Ledger
): CreatorStats {
  let sales: number | null = null;
  let net: number | null = null;
  let mints = 0;
  for (const fact of drops) {
    const record = latest.get(`${fact.chain}|${fact.contract.toLowerCase()}`);
    if (record) {
      if (record.salesCount !== null) sales = (sales ?? 0) + record.salesCount;
      if (record.netUsd !== null) net = (net ?? 0) + record.netUsd;
    }
    const entry = ledger ? entryOf(ledger, fact.chain, fact.contract) : undefined;
    if (entry?.status === "SUCCESS") mints += entry.quantity;
  }

  const withSupply = drops.filter((drop) => drop.maxSupply !== null && drop.maxSupply > 0n);
  const velocities = drops.map((drop) => drop.velocity24h).filter((v): v is bigint => v !== null);
  return {
    owner,
    dropCount: drops.length,
    soldOutRate: withSupply.length > 0 ? withSupply.filter((drop) => drop.soldOut).length / withSupply.length : null,
    avgVelocity24h:
      velocities.length > 0 ? Math.round(velocities.reduce((sum, v) => sum + Number(v), 0) / velocities.length) : null,
    salesCount: sales,
    ownMints: mints,
    ownNetUsd: net,
    ownData: mints > 0 || net !== null || sales !== null,
  };
}

export interface QualitySignals {
  phase: Phase;
  stale: boolean;
  mintPriceWei: string | null;
  startSec: number | null;
  endSec: number | null;
  nowSec: number;
  maxSupply: bigint | null;
  minted: bigint | null;
  remaining: bigint | null;
  velocity24h: bigint | null;
  uniqueMinters: number | null;
  topMinterShare: number | null;
  presaleStages: number | null;
  presaleShare: number | null; // absorbed by the presale stages, 0-1
  capPerWallet: number | null;
  creator: CreatorStats | null;
  social: SocialFact | null;
}

export type Penalty = "stale" | "concentrated" | "no-socials" | "instant-sellout";
export type QualityDimension = "demand" | "participation" | "creator" | "social" | "structure";

export interface QualityResult {
  score: number | null; // 0-100 over the dimensions that had data
  confidence: number; // 0-1, share of weight that had data
  dimensions: Record<QualityDimension, number | null>;
  penalties: Penalty[];
}

const WEIGHTS: Record<QualityDimension, number> = {
  demand: 30,
  participation: 20,
  creator: 20,
  social: 15,
  structure: 15,
};

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);
const round2 = (value: number): number => Math.round(value * 100) / 100;

function demandScore(input: QualitySignals): number | null {
  if (input.maxSupply === null || input.maxSupply <= 0n) return null;
  if (input.velocity24h !== null) {
    // 1% of the supply per day is a full-marks pace.
    return clamp01(Number(input.velocity24h) / (Number(input.maxSupply) / 100));
  }
  // Before the public sale there is no velocity. The share the presale already
  // absorbed is the only demand signal available — half the supply is full marks.
  if (input.presaleShare != null && input.presaleShare > 0) return clamp01(input.presaleShare / 0.5);
  return null;
}

function participationScore(input: QualitySignals): number | null {
  if (input.uniqueMinters === null) return null;
  const breadth = clamp01(input.uniqueMinters / 50);
  // Unknown concentration is treated as a caution, not as clean.
  const concentration =
    input.topMinterShare === null ? 0.5 : input.topMinterShare < 0.2 ? 1 : input.topMinterShare < 0.5 ? 0.5 : 0;
  return breadth * concentration;
}

function creatorScore(creator: CreatorStats | null): number | null {
  // dropCount 0 means "no other drop to judge" — that is unknown, not bad. The
  // target itself is excluded upstream so a hit cannot score on its own success.
  if (!creator || creator.dropCount === 0) return null;
  const reliability = creator.soldOutRate ?? 0.5;
  const track = clamp01(creator.dropCount / 5);
  const pace = creator.avgVelocity24h === null ? 0.5 : clamp01(creator.avgVelocity24h / 100);
  return 0.5 * reliability + 0.3 * track + 0.2 * pace;
}

function socialScore(social: SocialFact | null, nowSec: number): number | null {
  if (!social) return null;
  const createdMs = social.createdDate ? Date.parse(social.createdDate) : NaN;
  const ageDays = Number.isFinite(createdMs) ? (nowSec - createdMs / 1000) / 86_400 : null;
  const safelistOk = social.safelist === "approved" || social.safelist === "verified";
  return (
    0.25 * (social.twitter ? 1 : 0) +
    0.25 * (social.discord ? 1 : 0) +
    0.2 * (social.website ? 1 : 0) +
    0.15 * (ageDays !== null && ageDays >= 3 ? 1 : 0) +
    0.15 * (safelistOk ? 1 : 0)
  );
}

function structureScore(input: QualitySignals): number | null {
  if (input.phase === "unaudited" || input.startSec === null || input.endSec === null) return null;
  const windowSec = input.endSec - input.startSec;
  return (
    0.4 * ((input.presaleStages ?? 0) > 0 ? 1 : 0) +
    0.3 * (input.capPerWallet !== null && input.capPerWallet >= 1 && input.capPerWallet <= 20 ? 1 : 0) +
    0.3 * (windowSec > 0 && windowSec <= 72 * 3_600 ? 1 : 0)
  );
}

// The Obscura pattern: free, most of the supply already absorbed by the presale,
// a wide audience and several per wallet — the public remainder gets swept by
// batch contracts, so a single wallet has no realistic shot.
function instantSellout(input: QualitySignals): boolean {
  return (
    input.mintPriceWei === "0" &&
    input.presaleShare != null &&
    input.presaleShare >= 0.4 &&
    input.uniqueMinters != null &&
    input.uniqueMinters >= 1000 &&
    input.capPerWallet != null &&
    input.capPerWallet >= 5
  );
}

export function qualityScore(input: QualitySignals): QualityResult {
  const raw: Record<QualityDimension, number | null> = {
    demand: demandScore(input),
    participation: participationScore(input),
    creator: creatorScore(input.creator),
    social: socialScore(input.social, input.nowSec),
    structure: structureScore(input),
  };

  let weightSum = 0;
  let scoreSum = 0;
  const dimensions = {} as Record<QualityDimension, number | null>;
  for (const key of Object.keys(WEIGHTS) as QualityDimension[]) {
    const value = raw[key];
    dimensions[key] = value === null ? null : Math.round(value * 100);
    if (value !== null) {
      weightSum += WEIGHTS[key];
      scoreSum += WEIGHTS[key] * value;
    }
  }

  const penalties: Penalty[] = [];
  if (input.stale) penalties.push("stale");
  if (input.topMinterShare !== null && input.topMinterShare >= 0.5) penalties.push("concentrated");
  if (input.social !== null && !input.social.twitter && !input.social.discord && !input.social.website) {
    penalties.push("no-socials");
  }
  if (instantSellout(input)) penalties.push("instant-sellout");

  let confidence = weightSum / 100;
  if (input.creator?.ownData) confidence = Math.min(1, confidence + 0.1);

  return {
    score: weightSum === 0 ? null : Math.round((scoreSum / weightSum) * 100),
    confidence: round2(confidence),
    dimensions,
    penalties,
  };
}

// Only https images from OpenSea's CDNs may end up in a src attribute; anything
// else is dropped rather than escaped-and-hoped.
export function safeImageUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return null;
    const host = parsed.hostname.toLowerCase();
    const allowed = host === "seadn.io" || host.endsWith(".seadn.io") || host === "opensea.io" || host.endsWith(".opensea.io");
    return allowed ? parsed.toString() : null;
  } catch {
    return null;
  }
}

export function safeLinkUrl(url: string | null | undefined): string | null {
  if (!url || !url.trim()) return null;
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}
