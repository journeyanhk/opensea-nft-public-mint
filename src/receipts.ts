// What a receipt actually proves.
//
// `status == 1` only means the transaction did not revert — a SeaDrop mint can
// succeed with the wallet receiving nothing at all (a race the clone contracts
// win), and it can succeed with fewer tokens than requested when the supply
// runs out mid-batch. The ledger has to record what arrived, not what we hoped
// for, otherwise every downstream number (cost basis, net, "did I get in") is
// fiction.

import { Interface } from "ethers";

export type ReceiptVerdict = "MINTED" | "PARTIAL" | "NO_MINT" | "REVERTED";

export interface RawReceiptLog {
  address: string;
  topics: string[];
  data: string;
}

export interface MintedTokens {
  count: number;
  tokenIds: string[];
  kind: "ERC721" | "ERC1155" | null;
  // Some endpoints answer without logs. "We could not see the logs" must never
  // be reported as "you got nothing".
  logsAvailable: boolean;
}

const erc721 = new Interface(["event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)"]);
const erc1155 = new Interface([
  "event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)",
  "event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)",
]);

const TRANSFER_TOPIC = erc721.getEvent("Transfer")!.topicHash.toLowerCase();
const TRANSFER_SINGLE_TOPIC = erc1155.getEvent("TransferSingle")!.topicHash.toLowerCase();
const TRANSFER_BATCH_TOPIC = erc1155.getEvent("TransferBatch")!.topicHash.toLowerCase();
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const topicAddress = (topic: string): string => `0x${topic.slice(-40)}`.toLowerCase();
const tokenId = (topic: string): string => BigInt(topic).toString();

export function countMintedTokens(
  receipt: { logs?: RawReceiptLog[] } | null,
  opts: { nftContract: string; wallet: string }
): MintedTokens {
  const contract = opts.nftContract.toLowerCase();
  const wallet = opts.wallet.toLowerCase();
  const logsAvailable = Array.isArray(receipt?.logs);
  let count = 0;
  const tokenIds: string[] = [];
  let kind: MintedTokens["kind"] = null;

  for (const log of receipt?.logs ?? []) {
    if (log.address?.toLowerCase() !== contract) continue;
    const topic0 = (log.topics?.[0] ?? "").toLowerCase();

    if (topic0 === TRANSFER_TOPIC && log.topics.length === 4) {
      if (topicAddress(log.topics[1]) !== ZERO_ADDRESS) continue; // mint, not a transfer in
      if (topicAddress(log.topics[2]) !== wallet) continue;
      count += 1;
      tokenIds.push(tokenId(log.topics[3]));
      kind = kind ?? "ERC721";
      continue;
    }

    if (topic0 === TRANSFER_SINGLE_TOPIC) {
      try {
        if (topicAddress(log.topics[2]) !== ZERO_ADDRESS) continue;
        if (topicAddress(log.topics[3]) !== wallet) continue;
        const parsed = erc1155.parseLog({ topics: [...log.topics], data: log.data });
        if (!parsed) continue;
        const minted = Number(parsed.args.value);
        if (minted <= 0) continue;
        count += minted;
        tokenIds.push(parsed.args.id.toString());
        kind = "ERC1155";
      } catch {
        // not our event shape
      }
      continue;
    }

    if (topic0 === TRANSFER_BATCH_TOPIC) {
      try {
        if (topicAddress(log.topics[2]) !== ZERO_ADDRESS) continue;
        if (topicAddress(log.topics[3]) !== wallet) continue;
        const parsed = erc1155.parseLog({ topics: [...log.topics], data: log.data });
        if (!parsed) continue;
        // Positional access on purpose: Result is an array, so the named field
        // `values` resolves to Array.prototype.values instead of the argument.
        const ids = [...(parsed.args[3] as unknown as bigint[])];
        const values = [...(parsed.args[4] as unknown as bigint[])];
        for (let i = 0; i < ids.length; i++) {
          const minted = Number(values[i]);
          if (minted <= 0) continue;
          count += minted;
          tokenIds.push(ids[i].toString());
        }
        kind = "ERC1155";
      } catch {
        // not our event shape
      }
    }
  }

  return { count, tokenIds, kind, logsAvailable };
}

export function verdict(status: "SUCCESS" | "REVERTED", minted: number, quantity: number): ReceiptVerdict {
  if (minted >= quantity && quantity > 0) return "MINTED";
  if (minted > 0) return "PARTIAL";
  return status === "SUCCESS" ? "NO_MINT" : "REVERTED";
}
