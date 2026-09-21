// How many to mint per wallet, decided at the last moment.
//
// Free drops are the common case here, and a free drop is usually worth taking
// the per-wallet cap of (the cap is the creator's own limit, and it is the only
// quantity that is actually contested). Paid drops are rare and rules change
// close to the open, so they stay at one until proven otherwise.
//
// The decision is made after the fresh plan is read (T-refresh), never from the
// plan captured when the target was configured — that is the whole point.

export interface QuantityPolicyInput {
  mintPriceWei: bigint;
  capPerWallet: number; // 0 means unlimited in SeaDrop terms
  freeMaxQuantity: number; // 0 disables the policy
}

export function freeQuantityFor(input: QuantityPolicyInput): { quantity: number; reason: string } {
  const max = Math.max(0, Math.floor(input.freeMaxQuantity));
  if (max === 0) return { quantity: 1, reason: "quantity policy off (FREE_MAX_QUANTITY=0)" };
  if (input.mintPriceWei > 0n) return { quantity: 1, reason: "paid drop → 1" };
  if (input.capPerWallet > 0) {
    return {
      quantity: Math.min(input.capPerWallet, max),
      reason: `free drop, per-wallet cap ${input.capPerWallet} → ${Math.min(input.capPerWallet, max)}`,
    };
  }
  return { quantity: max, reason: `free drop, no per-wallet cap → ${max} (FREE_MAX_QUANTITY)` };
}
