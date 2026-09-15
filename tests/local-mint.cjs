const { test } = require('node:test');
const assert = require('node:assert/strict');
const { reconcileStart } = require('../dist/local-mint');

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
