const { test } = require('node:test');
const assert = require('node:assert/strict');
const { reconcileStart, supplyVerdict, exceedsWalletCap } = require('../dist/local-mint');

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;

test('waits again when the opening is postponed', () => {
  const planned = NOW + MINUTE;
  const chain = planned + 30 * MINUTE;
  assert.deepEqual(reconcileStart(planned, chain, NOW, 0), { startMs: chain, rewait: true });
});

test('adopts a postponed opening without another refresh window at the cap', () => {
  const planned = NOW + MINUTE;
  const chain = planned + 30 * MINUTE;
  assert.deepEqual(reconcileStart(planned, chain, NOW, 2), { startMs: chain, rewait: false });
});

test('handles a target reached with no plan, stage still ahead or already open', () => {
  const chain = NOW + 30 * MINUTE;
  assert.deepEqual(reconcileStart(null, chain, NOW, 0), { startMs: chain, rewait: true });
  assert.deepEqual(reconcileStart(null, NOW - 1000, NOW, 0), { startMs: null, rewait: false });
});

test('fires as soon as the chain allows when the opening moved earlier', () => {
  const planned = NOW + 60 * MINUTE;
  assert.deepEqual(reconcileStart(planned, NOW - 5_000, NOW, 0), { startMs: NOW, rewait: false });
});

test('keeps the plan when the start has not moved', () => {
  const planned = NOW + MINUTE;
  assert.deepEqual(reconcileStart(planned, planned - 500, NOW, 0), { startMs: planned, rewait: false });
});

test('supply verdict flags sold-out and tight targets', () => {
  assert.equal(supplyVerdict(5000n, 5000n, 1n), 'sold-out');
  assert.equal(supplyVerdict(4445n, 4444n, 1n), 'sold-out');
  assert.equal(supplyVerdict(4443n, 4444n, 3n), 'tight');
  assert.equal(supplyVerdict(0n, 5000n, 3n), 'ok');
  assert.equal(supplyVerdict(5000n, 0n, 1n), 'ok');
});

test('detects wallets already at the per-wallet cap', () => {
  assert.equal(exceedsWalletCap(1n, 1, 1), true);
  assert.equal(exceedsWalletCap(0n, 1, 1), false);
  assert.equal(exceedsWalletCap(2n, 1, 3), false);
  assert.equal(exceedsWalletCap(3n, 1, 3), true);
  assert.equal(exceedsWalletCap(9n, 1, 0), false);
});
