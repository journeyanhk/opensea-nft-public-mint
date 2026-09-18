// Seaport 1.6 sales: the chain's own floor-price source.
//
// Seaport 1.6 changed the ReceivedItem struct: consideration entries carry a
// fifth `recipient` field, so the OrderFulfilled topic differs from 1.1–1.5 —
// using the older signature silently matches nothing. The NFT contract is NOT
// indexed (topic1 is the offerer), so logs are decoded and filtered by the offer
// items instead of by a topic filter.
//
// Payment may be native or an ERC-20 (Robinhood collections price in USDG or
// WETH), so the caller resolves decimals before comparing anything.

import { Interface, id } from "ethers";
import { RawLog, estimateBlockTime, scanLogs } from "../audit/events";
import { resolveScanRpcs } from "../rpc-resolver";

export const SEAPORT_ADDRESS = "0x0000000000000068F116a894984e2DB1123eB395";

export const ORDER_FULFILLED_TOPIC = id(
  "OrderFulfilled(bytes32,address,address,address,(uint8,address,uint256,uint256)[],(uint8,address,uint256,uint256,address)[])"
);

const IFACE = new Interface([
  "event OrderFulfilled(bytes32 orderHash, address indexed offerer, address indexed zone, address recipient, tuple(uint8 itemType, address token, uint256 identifier, uint256 amount)[] offer, tuple(uint8 itemType, address token, uint256 identifier, uint256 amount, address recipient)[] consideration)",
]);

export interface Sale {
  block: number;
  nft: string; // lowercased contract
  identifier: string;
  buyer: string; // top-level recipient (the NFT receiver)
  payToken: string; // 0x0 for the native coin
  amountAtomic: bigint; // sum of all payment items in the dominant currency
  mixedCurrencies: boolean;
}

export function decodeOrderFulfilled(log: RawLog): Sale | null {
  try {
    const parsed = IFACE.parseLog({ topics: [...log.topics], data: log.data });
    if (!parsed) return null;
    const offer = parsed.args.offer as unknown as { itemType: number; token: string }[];
    const consideration = parsed.args.consideration as unknown as {
      itemType: number;
      token: string;
      amount: bigint;
    }[];

    const nft = offer.find((item) => Number(item.itemType) >= 2);
    if (!nft) return null;

    const byToken = new Map<string, bigint>();
    for (const item of consideration) {
      if (Number(item.itemType) > 1) continue;
      const key = String(item.token).toLowerCase();
      byToken.set(key, (byToken.get(key) ?? 0n) + BigInt(item.amount));
    }
    if (byToken.size === 0) return null;

    let payToken = "";
    let amountAtomic = 0n;
    for (const [token, amount] of byToken) {
      if (amount > amountAtomic) {
        payToken = token;
        amountAtomic = amount;
      }
    }

    return {
      block: Number(BigInt(log.blockNumber)),
      nft: String(nft.token).toLowerCase(),
      identifier: String((nft as unknown as { identifier: bigint }).identifier),
      buyer: String(parsed.args.recipient).toLowerCase(),
      payToken,
      amountAtomic,
      mixedCurrencies: byToken.size > 1,
    };
  } catch {
    return null;
  }
}

export interface SaleStats {
  count: number;
  lowAtomic: bigint;
  medianAtomic: bigint;
  uniqueBuyers: number;
  payToken: string;
  latestBlock: number;
  mixedCurrencies: boolean;
}

export function aggregateSales(sales: Sale[], maxSales = 50): SaleStats | null {
  if (sales.length === 0) return null;
  const recent = [...sales].sort((a, b) => b.block - a.block).slice(0, maxSales);

  const byToken = new Map<string, number>();
  for (const sale of recent) byToken.set(sale.payToken, (byToken.get(sale.payToken) ?? 0) + 1);
  const payToken = [...byToken].sort((a, b) => b[1] - a[1])[0][0];
  const sameCurrency = recent.filter((s) => s.payToken === payToken);

  const amounts = sameCurrency.map((s) => s.amountAtomic).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = Math.floor(amounts.length / 2);
  const medianAtomic = amounts.length % 2 === 1 ? amounts[mid] : (amounts[mid - 1] + amounts[mid]) / 2n;

  return {
    count: sameCurrency.length,
    lowAtomic: amounts[0],
    medianAtomic,
    uniqueBuyers: new Set(sameCurrency.map((s) => s.buyer)).size,
    payToken,
    latestBlock: Math.max(...sameCurrency.map((s) => s.block)),
    mixedCurrencies: byToken.size > 1 || sameCurrency.some((s) => s.mixedCurrencies),
  };
}

export interface ScanSalesOptions {
  lookbackHours?: number;
  maxSales?: number;
  onProgress?: (message: string) => void;
}

// Throws when the scan itself fails: a silent empty result would look like "no
// sales" and corrupt the record (that mistake produced a wrong "no secondary
// market" conclusion once already).
export async function scanSeaportSales(
  chainKey: string,
  contract: string,
  opts: ScanSalesOptions = {}
): Promise<SaleStats | null> {
  const lookbackHours = opts.lookbackHours ?? 24;
  const { urls } = resolveScanRpcs(chainKey);
  if (urls.length === 0) throw new Error(`No RPC endpoint for ${chainKey}`);

  const { latestBlock, secondsPerBlock } = await estimateBlockTime(urls[0]);
  const lookbackBlocks = Math.max(1_000, Math.ceil((lookbackHours * 3_600) / secondsPerBlock));
  const fromBlock = Math.max(0, latestBlock - lookbackBlocks);

  const logs = await scanLogs(chainKey, SEAPORT_ADDRESS, [ORDER_FULFILLED_TOPIC], fromBlock, latestBlock, {
    rpcUrls: urls,
    maxRetries: 8,
    onProgress: opts.onProgress,
  });

  const target = contract.toLowerCase();
  const sales: Sale[] = [];
  for (const log of logs) {
    const sale = decodeOrderFulfilled(log);
    if (sale && sale.nft === target) sales.push(sale);
  }
  return aggregateSales(sales, opts.maxSales);
}
