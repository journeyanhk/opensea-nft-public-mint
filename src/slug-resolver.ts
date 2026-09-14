// Turn an OpenSea collection slug into a contract address.
//
// The API key is optional. OpenSea's public collections endpoint often answers
// unauthenticated, so we always attempt the lookup and only attach a key when
// one is configured — the key makes this reliable rather than possible. If the
// lookup is refused, the caller falls back to asking for the contract address
// directly, which never needs a key at all.

interface CollectionInfo {
  name: string;
  contractAddress: string;
  chain: string;
}

export async function resolveSlug(
  slug: string,
  apiKey?: string,
  preferredChain?: string
): Promise<CollectionInfo> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (apiKey) headers["x-api-key"] = apiKey;

  const res = await fetch(`https://api.opensea.io/api/v2/collections/${slug}`, { headers });

  if (res.status === 401 || res.status === 403) {
    // Unauthenticated lookups get 401 both for an unknown slug and for one that
    // needs a key, so the message has to cover both rather than guess.
    throw new Error(
      apiKey
        ? `OpenSea 拒绝了 API key (${res.status}) — 请检查 OPENSEA_API_KEY。`
        : `OpenSea 拒绝了查询 (${res.status}) — slug 可能有误或需要 API key。`
    );
  }
  if (res.status === 404) {
    throw new Error(`未找到 OpenSea 集合 "${slug}"。`);
  }
  if (res.status === 429) {
    throw new Error("OpenSea 查询频率受限 — 请稍后重试。");
  }
  if (!res.ok) {
    throw new Error(`无法解析 "${slug}": ${res.status} ${res.statusText}`);
  }

  const json = (await res.json()) as any;

  const contracts = json.contracts;
  if (!contracts || contracts.length === 0) {
    throw new Error(`"${slug}" 没有列出任何合约。`);
  }

  // Prefer the contract on the chain we're actually minting on, otherwise take
  // whichever OpenSea lists first.
  const wanted = preferredChain?.trim().toLowerCase();
  const picked =
    (wanted && contracts.find((c: any) => c.chain?.toLowerCase() === wanted)) || contracts[0];

  return {
    name: json.name || slug,
    contractAddress: picked.address,
    chain: picked.chain,
  };
}

// A slug is anything that isn't a raw contract address.
export function isSlug(input: string): boolean {
  return !input.startsWith("0x");
}
