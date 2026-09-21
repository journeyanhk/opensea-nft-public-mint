const { test } = require('node:test');
const assert = require('node:assert/strict');
const { applyPlanFacts, isPriceFlip, freshest } = require('../dist/scan/price-watch');

const entry = () => ({
  mintPriceWei: null, capPerWallet: null, feeRecipient: null,
  publicStart: null, endTime: null, factsAt: null, mintPriceChangedAt: null, priceHistory: [],
});
const drop = (priceWei, cap, start = 1_000, end = 2_000) => ({ mintPrice: BigInt(priceWei), maxTotalMintableByWallet: cap, startTime: start, endTime: end });

test('applyPlanFacts records the read time and only marks a change on a real move', () => {
  const target = entry();
  assert.equal(applyPlanFacts(target, drop(0, 50), '0xfee', '2026-09-21T10:00:00.000Z').priceChanged, false, 'the first read is not a change');
  assert.equal(target.mintPriceWei, '0');
  assert.equal(target.capPerWallet, 50);
  assert.equal(target.factsAt, '2026-09-21T10:00:00.000Z');
  assert.equal(target.mintPriceChangedAt, null);
  assert.deepEqual(target.priceHistory, [], 'nothing to record yet');

  // The bait pattern: free -> paid right after the open.
  assert.equal(applyPlanFacts(target, drop(50_000_000_000_000n, 10_000), '0xfee', '2026-09-21T10:16:00.000Z').priceChanged, true);
  assert.equal(target.mintPriceChangedAt, '2026-09-21T10:16:00.000Z');
  assert.deepEqual(target.priceHistory, [{ at: '2026-09-21T10:16:00.000Z', priceWei: '50000000000000', cap: 10_000 }]);

  // Re-reading the same terms does not add noise.
  applyPlanFacts(target, drop(50_000_000_000_000n, 10_000), '0xfee', '2026-09-21T11:00:00.000Z');
  assert.equal(target.priceHistory.length, 1);
  assert.equal(target.factsAt, '2026-09-21T11:00:00.000Z', 'the read time still moves forward');
});

test('a flip is free -> paid, or any change around the open', () => {
  const bait = { ...entry(), mintPriceWei: '5000', priceHistory: [{ at: 't', priceWei: '0', cap: 50 }], mintPriceChangedAt: null, publicStart: 1_000 };
  assert.equal(isPriceFlip(bait, { nowMs: 2_000_000 }), true);

  const nearby = { ...entry(), mintPriceWei: '5000', priceHistory: [], mintPriceChangedAt: '2026-09-21T10:00:30.000Z', publicStart: Math.floor(Date.parse('2026-09-21T10:00:00.000Z') / 1000) };
  assert.equal(isPriceFlip(nearby, { nowMs: Date.parse('2026-09-21T10:01:00.000Z') }), true, 'changed 30s after the open');

  const longAgo = { ...entry(), mintPriceWei: '5000', priceHistory: [], mintPriceChangedAt: '2026-09-20T10:00:00.000Z', publicStart: Math.floor(Date.parse('2026-09-21T10:00:00.000Z') / 1000) };
  assert.equal(isPriceFlip(longAgo, { nowMs: Date.parse('2026-09-21T10:01:00.000Z') }), false, 'a day before the open is not bait');

  assert.equal(isPriceFlip({ ...entry(), mintPriceWei: '0' }, { nowMs: 1 }), false, 'still free: nothing to flag');
});

test('the freshest price wins over a stale discovery snapshot', () => {
  // A discovery snapshot from 10:00 and an audit from 10:16: the audit wins.
  assert.equal(
    freshest([
      { value: '0', at: '2026-09-21T10:00:00.000Z' },
      { value: '5000', at: '2026-09-21T10:16:00.000Z' },
    ]),
    '5000'
  );
  // No timestamp (old data) loses to one that has it.
  assert.equal(freshest([{ value: '0' }, { value: '5000', at: '2026-09-21T10:16:00.000Z' }]), '5000');
  assert.equal(freshest([{ value: null, at: 't' }]), null);
});
