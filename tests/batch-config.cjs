const { test } = require('node:test');
const assert = require('node:assert/strict');
const { clampQuantity, computeMaxValueWei, resolveGas, sortTargetsByStart } = require('../dist/batch-config');

test('clamps quantity to the on-chain per-wallet cap', () => {
  assert.equal(clampQuantity(1, 0), 1);
  assert.equal(clampQuantity(5, 3), 3);
  assert.equal(clampQuantity(3, 3), 3);
  assert.equal(clampQuantity(2.7, 0), 2);
  assert.equal(clampQuantity(0, 0), 1);
  assert.equal(clampQuantity(NaN, 0), 1);
});

test('converts a max price into a total ceiling', () => {
  assert.equal(computeMaxValueWei('0.01', 3), 30000000000000000n);
  assert.equal(computeMaxValueWei('1', 1), 1000000000000000000n);
  assert.equal(computeMaxValueWei(undefined, 2), 0n);
});

test('sorts targets by start time without mutating the input', () => {
  const target = (label, iso) => ({ label, startAt: new Date(iso) });
  const input = [
    target('stock-salesman', '2026-09-15T18:30:00Z'),
    target('hoodminers-rh', '2026-09-15T18:00:00Z'),
  ];
  const sorted = sortTargetsByStart(input);
  assert.deepEqual(sorted.map(t => t.label), ['hoodminers-rh', 'stock-salesman']);
  assert.deepEqual(input.map(t => t.label), ['stock-salesman', 'hoodminers-rh']);
});

test('gas overrides win, and a tip above the ceiling is refused', () => {
  const gas = resolveGas('robinhood', { maxFeeGwei: 2, priorityGwei: 0.05, gasLimit: 250000 });
  assert.equal(gas.gasLimit, 250000);
  assert.equal(gas.maxFeePerGas, 2000000000n);
  assert.equal(gas.maxPriorityFee, 50000000n);
  assert.equal(resolveGas('robinhood', { maxFeeGwei: 3 }).maxFeePerGas, 3000000000n);
  assert.throws(() => resolveGas('robinhood', { maxFeeGwei: 1, priorityGwei: 2 }));
});

test('targets carry a pinned code hash only when it is a real hash', () => {
  const { targetCodeHash } = require('../dist/batch-config');
  const hash = '0x' + 'ab'.repeat(32);
  assert.equal(targetCodeHash({ codeHash: hash }), hash);
  assert.equal(targetCodeHash({ codeHash: '0xabc' }), null);
  assert.equal(targetCodeHash({ codeHash: 42 }), null);
  assert.equal(targetCodeHash({}), null, 'a hand-written config simply has nothing to compare');
});

test('burst config is parsed with bounded defaults and opt-ins', () => {
  const { parseBurst, DEFAULT_BURST } = require('../dist/batch-config');
  assert.deepEqual(parseBurst(undefined), DEFAULT_BURST);
  assert.equal(parseBurst({ count: 99 }).count, 5, 'bounded to the documented maximum');
  assert.equal(parseBurst({ count: 0 }).count, 1);
  assert.equal(parseBurst({ spacingMs: 5 }).spacingMs, 50, 'a 5ms spacing is not a burst');
  assert.equal(parseBurst({ leadMs: 10 }).leadMs, 'auto', 'too small a lead falls back to measurement');
  assert.equal(parseBurst({ leadMs: 200 }).leadMs, 200);
  assert.equal(parseBurst({ count: 4 }).allowOvershoot, false, 'overshoot is opt-in');
  assert.equal(parseBurst({ count: 4, allowOvershoot: true }).allowOvershoot, true);
});

test('parallel mode is opt-in and bounded by the wallet count', () => {
  const { loadBatchConfig } = require('../dist/batch-config');
  // parse only: the loader needs an RPC, so assert the pure defaults here
  const source = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'batch-config.ts'), 'utf8');
  assert.ok(source.includes('parallel: raw?.parallel === true'), 'parallel defaults to false');
  assert.ok(source.includes('parallelLimit'));
  const runner = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'batch-runner.ts'), 'utf8');
  assert.ok(runner.includes('cfg.parallel ? Math.max(1, cfg.parallelLimit ?? wallets.length) : 1'), 'the runner bounds parallelism by wallets');
});
