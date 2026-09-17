// Config merging and queue reconciliation for --watch.
//
// The batch runner owns the network side; everything here is pure so the merge
// and diff behaviour can be tested without a chain.

export interface RawConfig {
  chain?: string;
  targets?: unknown[];
  [key: string]: unknown;
}

// Target identity for dedupe: the config input, lowercased and trimmed. Two
// entries pointing at the same contract through different forms are not merged
// here; loadBatchConfig resolves them and the runner keys on the address.
export function rawTargetKey(target: unknown): string {
  const slug = (target as { slug?: unknown } | null)?.slug;
  return String(slug ?? "").trim().toLowerCase();
}

// The main file wins on chain-specific settings; targets are concatenated and
// deduped with the main file first, so a re-export that repeats a target does
// not queue it twice.
export function mergeRawConfigs(main: RawConfig, extras: RawConfig[]): RawConfig {
  const chains = [main, ...extras].map((c) => c?.chain).filter((c) => c !== undefined);
  const chain = chains[0];
  if (chain !== undefined && chains.some((c) => c !== chain)) {
    throw new Error(`All watched configs must share one chain (saw ${[...new Set(chains)].join(", ")}).`);
  }

  const seen = new Set<string>();
  const targets: unknown[] = [];
  for (const config of [main, ...extras]) {
    for (const target of config?.targets ?? []) {
      const key = rawTargetKey(target);
      if (key.length === 0 || seen.has(key)) continue;
      seen.add(key);
      targets.push(target);
    }
  }
  return { ...main, chain, targets };
}

export function diffKeys(previous: Set<string>, incoming: Set<string>): { added: string[]; removed: string[] } {
  const added = [...incoming].filter((key) => !previous.has(key));
  const removed = [...previous].filter((key) => !incoming.has(key));
  return { added, removed };
}
