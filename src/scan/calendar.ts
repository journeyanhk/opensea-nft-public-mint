// OpenSea's drops calendar as a second discovery source.
//
// The chain only knows a drop once it has been configured — often an hour
// before opening — while the calendar publishes start time, floor and
// verification days ahead. The page ships its data as a urql transport payload
// (not __NEXT_DATA__, which this page does not use): only that JSON is parsed,
// page scripts are never executed.
//
// A parse that yields nothing must fail loud. "We could not read the calendar"
// and "the calendar is empty" are different statements, and silently treating
// the first as the second would empty the board without a single warning.

import { emptyContractEntry } from "./state";
import type { ContractEntry, ScanState } from "./state";

export interface CalendarStage {
  startTime: number | null;
  endTime: number | null;
}

export interface CalendarFacts {
  listedAt: string;
  startTime: number | null; // earliest stage
  endTime: number | null; // latest stage
  floorUsd: number | null;
  floorValue: number | null;
  floorSymbol: string | null;
  topOfferValue: number | null;
  volume24hUsd: number | null;
  volume24hValue: number | null;
  isVerified: boolean | null;
  disabledReason: string | null;
  maxSupply: string | null;
  totalSupply: string | null;
  stages: CalendarStage[];
}

export interface CalendarEntry extends Omit<CalendarFacts, "listedAt"> {
  slug: string;
  name: string | null;
  chain: string;
  address: string | null;
}

export const CALENDAR_URL = "https://opensea.io/drops/upcoming";
// The page 307s to /drops; without a browser UA the redirect target can be a
// stub, so both are pinned here.
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function walk(value: unknown, visit: (node: Record<string, unknown>) => void): void {
  if (!value || typeof value !== "object") return;
  visit(value as Record<string, unknown>);
  for (const child of Object.values(value as Record<string, unknown>)) walk(child, visit);
}

const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

function toSeconds(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

interface RawItem {
  identifier?: { contractAddress?: unknown; chain?: { identifier?: unknown } };
  collection?: {
    slug?: unknown;
    name?: unknown;
    chain?: { identifier?: unknown };
    isVerified?: unknown;
    floorPrice?: { pricePerItem?: { usd?: unknown; token?: { unit?: unknown; symbol?: unknown } } };
    topOffer?: { pricePerItem?: { token?: { unit?: unknown } } };
    stats?: { oneDay?: { volume?: { usd?: unknown; token?: { unit?: unknown; symbol?: unknown } } } };
    drop?: {
      disabledReason?: unknown;
      maxSupply?: unknown;
      totalSupply?: unknown;
      stages?: { startTime?: unknown; start_time?: unknown; endTime?: unknown; end_time?: unknown }[];
    };
  };
}

export function parseCalendar(html: string): CalendarEntry[] {
  const objects: unknown[] = [];
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    const script = match[1];
    if (!script.includes("urql_transport")) continue;
    const at = script.indexOf(".push(");
    if (at < 0) continue;
    try {
      objects.push(JSON.parse(script.slice(at + 6).replace(/\);?\s*$/, "")));
    } catch {
      // other transport pushes on the page are not ours to parse
    }
  }
  if (objects.length === 0) {
    throw new Error("OpenSea calendar payload not found — the page format changed, or the request was blocked");
  }

  const rows = new Map<string, CalendarEntry>();
  walk(objects, (node) => {
    const items = (node as { dropCalendar?: { items?: unknown } }).dropCalendar?.items;
    if (!Array.isArray(items)) return;
    for (const raw of items as RawItem[]) {
      const collection = raw.collection ?? {};
      const slug = str(collection.slug);
      const chain = str(raw.identifier?.chain?.identifier) ?? str(collection.chain?.identifier);
      if (!slug || !chain || !/^[a-z0-9_-]+$/i.test(slug)) continue;

      const stages = (collection.drop?.stages ?? []).map((stage) => ({
        startTime: toSeconds(stage.startTime ?? stage.start_time),
        endTime: toSeconds(stage.endTime ?? stage.end_time),
      }));
      const starts = stages.map((stage) => stage.startTime).filter((value): value is number => value !== null);
      const ends = stages.map((stage) => stage.endTime).filter((value): value is number => value !== null);
      const floor = collection.floorPrice?.pricePerItem;
      const top = collection.topOffer?.pricePerItem;
      const volume = collection.stats?.oneDay?.volume;

      rows.set(slug, {
        slug,
        name: str(collection.name),
        chain,
        address: str(raw.identifier?.contractAddress),
        startTime: starts.length > 0 ? Math.min(...starts) : null,
        endTime: ends.length > 0 ? Math.max(...ends) : null,
        floorUsd: num(floor?.usd),
        floorValue: num(floor?.token?.unit),
        floorSymbol: str(floor?.token?.symbol),
        topOfferValue: num(top?.token?.unit),
        volume24hUsd: num(volume?.usd),
        volume24hValue: num(volume?.token?.unit),
        isVerified: typeof collection.isVerified === "boolean" ? collection.isVerified : null,
        disabledReason: str(collection.drop?.disabledReason),
        maxSupply: collection.drop?.maxSupply == null ? null : String(collection.drop.maxSupply),
        totalSupply: collection.drop?.totalSupply == null ? null : String(collection.drop.totalSupply),
        stages,
      });
    }
  });

  if (rows.size === 0) {
    throw new Error("OpenSea calendar payload had no dropCalendar items — cannot tell 'empty' from 'broken'");
  }
  return [...rows.values()];
}

// A chain that had entries yesterday and none today, or a total count that
// collapsed, is a parser/blocking problem rather than an empty calendar.
export function calendarVerdict(
  previous: Record<string, number> | null,
  counts: Record<string, number>
): { warnings: string[] } {
  const warnings: string[] = [];
  for (const [chain, before] of Object.entries(previous ?? {})) {
    if (before > 0 && (counts[chain] ?? 0) === 0) warnings.push(`chain-empty:${chain}`);
  }
  const before = Object.values(previous ?? {}).reduce((sum, value) => sum + value, 0);
  const now = Object.values(counts).reduce((sum, value) => sum + value, 0);
  if (before > 0 && now < before * 0.2) warnings.push("volume-drop");
  return { warnings };
}

export interface CalendarFetchOptions {
  url?: string;
  fetchFn?: (url: string, init: RequestInit) => Promise<Pick<Response, "ok" | "status" | "text">>;
  timeoutMs?: number;
  now?: () => Date;
}

export interface CalendarSnapshot {
  fetchedAt: string;
  entries: CalendarEntry[];
}

export async function fetchCalendar(opts: CalendarFetchOptions = {}): Promise<CalendarSnapshot> {
  const fetchFn = opts.fetchFn ?? ((url: string, init: RequestInit) => fetch(url, init));
  const response = await fetchFn(opts.url ?? CALENDAR_URL, {
    headers: {
      "user-agent": BROWSER_UA,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
  });
  if (!response.ok) throw new Error(`OpenSea calendar responded ${response.status}`);
  return { fetchedAt: (opts.now?.() ?? new Date()).toISOString(), entries: parseCalendar(await response.text()) };
}

export interface UpsertResult {
  added: number;
  updated: number;
}

// Calendar facts are additive: they never overwrite chain facts, and a slug that
// a scan already resolved is authoritative. Existing entries only gain fields.
export function upsertCalendar(state: ScanState, entries: CalendarEntry[], at: string): UpsertResult {
  let added = 0;
  let updated = 0;
  for (const entry of entries) {
    if (!entry.address) continue;
    const key = entry.address.toLowerCase();
    const contracts = (state.contracts[entry.chain] ??= {});
    const facts: CalendarFacts = {
      listedAt: at,
      startTime: entry.startTime,
      endTime: entry.endTime,
      floorUsd: entry.floorUsd,
      floorValue: entry.floorValue,
      floorSymbol: entry.floorSymbol,
      topOfferValue: entry.topOfferValue,
      volume24hUsd: entry.volume24hUsd,
      volume24hValue: entry.volume24hValue,
      isVerified: entry.isVerified,
      disabledReason: entry.disabledReason,
      maxSupply: entry.maxSupply,
      totalSupply: entry.totalSupply,
      stages: entry.stages,
    };
    const existing: ContractEntry | undefined = contracts[key];
    if (existing) {
      existing.calendar = facts;
      existing.sources = [...new Set([...(existing.sources ?? []), "opensea-calendar"])];
      updated++;
    } else {
      contracts[key] = {
        ...emptyContractEntry(),
        slug: entry.slug,
        name: entry.name,
        sources: ["opensea-calendar"],
        calendar: facts,
      };
      added++;
    }
  }
  return { added, updated };
}
