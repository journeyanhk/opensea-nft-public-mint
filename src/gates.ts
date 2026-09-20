// Execution gates: the three checks that stand between "we built a signed
// transaction" and "we broadcast it".
//
// The batch signs early on purpose (see local-mint.ts). That is what makes the
// arrival time competitive, and it is also why the payload has to be re-proven
// immediately before it leaves: the contract can be upgraded behind a proxy,
// the drop can change, and a signing bug must never turn into money spent.
//
//  1. contract identity — the code hash the audit saw must still hold
//  2. the signature itself — every field and the calldata are re-checked
//  3. a pending simulation per wallet — a revert before the open is expected,
//     a revert once open means this wallet cannot mint
//
// All three are pure or provider-agnostic so the decisions are testable without
// a chain.

import { Interface, Transaction, keccak256 } from "ethers";

const PUBLIC_IFACE = new Interface([
  "function mintPublic(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity) payable",
]);

export interface GateExpectation {
  from: string;
  chainId: bigint;
  to: string;
  nonce: number;
  data: string;
  value: bigint;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

export function validateSignedTx(rawTx: string, expected: GateExpectation): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  let parsed: Transaction;
  try {
    parsed = Transaction.from(rawTx);
  } catch (err) {
    return { ok: false, errors: [`unparseable signed transaction: ${(err as Error).message}`] };
  }

  const eq = (label: string, actual: unknown, want: unknown, normalise = (v: unknown) => String(v).toLowerCase()) => {
    if (normalise(actual) !== normalise(want)) errors.push(`${label} mismatch: signed ${actual} vs expected ${want}`);
  };

  eq("from", parsed.from, expected.from);
  eq("to", parsed.to, expected.to);
  eq("chainId", parsed.chainId, expected.chainId, (v) => String(v));
  eq("nonce", parsed.nonce, expected.nonce, (v) => String(v));
  eq("data", parsed.data, expected.data);
  eq("value", parsed.value, expected.value, (v) => String(v));
  eq("gasLimit", parsed.gasLimit, expected.gasLimit, (v) => String(v));
  eq("maxFeePerGas", parsed.maxFeePerGas, expected.maxFeePerGas, (v) => String(v));
  eq("maxPriorityFeePerGas", parsed.maxPriorityFeePerGas, expected.maxPriorityFeePerGas, (v) => String(v));

  return { ok: errors.length === 0, errors };
}

export function validateMintPublicCalldata(
  data: string,
  expected: { nftContract: string; feeRecipient: string; quantity: bigint }
): { ok: boolean; errors: string[] } {
  let parsed;
  try {
    parsed = PUBLIC_IFACE.parseTransaction({ data });
  } catch {
    return { ok: false, errors: ["calldata is not a mintPublic call"] };
  }
  if (!parsed) return { ok: false, errors: ["calldata is not a mintPublic call"] };

  const errors: string[] = [];
  const same = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase();
  if (!same(parsed.args.nftContract, expected.nftContract)) {
    errors.push(`calldata nftContract ${parsed.args.nftContract} != ${expected.nftContract}`);
  }
  if (!same(parsed.args.feeRecipient, expected.feeRecipient)) {
    errors.push(`calldata feeRecipient ${parsed.args.feeRecipient} != ${expected.feeRecipient}`);
  }
  if (BigInt(parsed.args.quantity) !== expected.quantity) {
    errors.push(`calldata quantity ${parsed.args.quantity} != ${expected.quantity}`);
  }
  const minter = String(parsed.args.minterIfNotPayer).toLowerCase();
  if (minter !== "0x0000000000000000000000000000000000000000") {
    errors.push(`minterIfNotPayer must be the zero address, got ${minter}`);
  }
  return { ok: errors.length === 0, errors };
}

// A revert before the stage opens is the expected answer (NotActive); once the
// stage is open, a revert means this wallet will not get in. A revert that
// names a payment or supply problem is fatal in either case.
const FATAL_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /incorrectpayment|insufficient payment|wrong value/i, label: "payment no longer matches the price" },
  { pattern: /mintquantityexceedsmaxsupply|max supply|sold out/i, label: "quantity exceeds the remaining supply" },
  { pattern: /feerecipientnotallowed|allowedfeerecipientnotset|fee recipient/i, label: "fee recipient is not allowed" },
  { pattern: /notallowlisted|not on allowlist|allowlist/i, label: "wallet is not on the allowlist" },
];

export function classifySimulation(input: {
  ok: boolean;
  errorText?: string | null;
  stageOpen: boolean;
}): { pass: boolean; label: string } {
  if (input.ok) return { pass: true, label: "simulation passed" };
  const text = input.errorText ?? "";
  for (const { pattern, label } of FATAL_PATTERNS) {
    if (pattern.test(text)) return { pass: false, label };
  }
  if (input.stageOpen) return { pass: false, label: "simulation reverted while the stage is open" };
  return { pass: true, label: "pre-open revert (expected)" };
}

// The audit pins the code hash it saw; an execution must refuse a different one
// (proxy upgrade, a different contract behind the same address). An empty
// account is the worst case, never "no change".
export function codeHashOf(code: string | null | undefined): string | null {
  if (!code || code === "0x" || code === "0x0") return null;
  return keccak256(code);
}
