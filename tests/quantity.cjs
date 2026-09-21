const { test } = require('node:test');
const assert = require('node:assert/strict');
const { freeQuantityFor } = require('../dist/quantity');

test('free drops take the per-wallet cap, paid drops take one', () => {
  // A free drop with a cap of 10 and a ceiling of 5: mint 5.
  assert.deepEqual(freeQuantityFor({ mintPriceWei: 0n, capPerWallet: 10, freeMaxQuantity: 5 }), {
    quantity: 5,
    reason: 'free drop, per-wallet cap 10 → 5',
  });
  // A cap below the ceiling is the cap.
  assert.equal(freeQuantityFor({ mintPriceWei: 0n, capPerWallet: 2, freeMaxQuantity: 5 }).quantity, 2);
  // No cap (SeaDrop 0): the ceiling is the answer.
  assert.equal(freeQuantityFor({ mintPriceWei: 0n, capPerWallet: 0, freeMaxQuantity: 5 }).quantity, 5);
  // Any price at all and the quantity is one, whatever the cap says.
  assert.equal(freeQuantityFor({ mintPriceWei: 1n, capPerWallet: 10, freeMaxQuantity: 5 }).quantity, 1);
  // The policy can be switched off.
  assert.equal(freeQuantityFor({ mintPriceWei: 0n, capPerWallet: 10, freeMaxQuantity: 0 }).quantity, 1);
  assert.equal(freeQuantityFor({ mintPriceWei: 0n, capPerWallet: 0, freeMaxQuantity: -3 }).quantity, 1);
});
