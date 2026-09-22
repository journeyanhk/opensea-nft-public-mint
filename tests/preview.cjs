const { test } = require('node:test');
const assert = require('node:assert/strict');
const { previewJob } = require('../dist/executor/preview');

const W = '0x65f001aa4109bb8d3bf70af66855aba1e5582625';
const base = {
  chain: 'robinhood',
  contract: W,
  quantity: 1,
  startAtMs: 1_700_000_000_000,
  existing: [],
  freeMaxQuantity: 10,
  gasLimit: 250_000,
  maxFeePerGasWei: '2000000000',
  riskFlags: [],
};

test('the preview says what the quantity policy will do and what it may cost', () => {
  // Free drop, cap 2: two tickets, priced at gas x 2 (the free path reserves no value).
  const free = previewJob({ ...base, entry: { mintPriceWei: '0', capPerWallet: 2, codeHash: '0x' + 'ab'.repeat(32), publicStart: 1_700_000_000 } });
  assert.equal(free.ok, true);
  assert.equal(free.quantity, 2);
  assert.match(free.quantityReason, /cap 2/);
  // Gas limit grows with the quantity (150k per extra mint + 60k overhead), as in local-mint.
  assert.equal(free.worstCaseWei, (360_000n * 2_000_000_000n).toString());
  assert.deepEqual(free.warnings, []);
  assert.deepEqual(free.conflicts, []);

  // Paid drop: one ticket, and the value is part of the worst case.
  const paid = previewJob({ ...base, entry: { mintPriceWei: '1000000000000000', capPerWallet: 5, codeHash: '0x' + 'ab'.repeat(32), publicStart: 1_700_000_000 } });
  assert.equal(paid.quantity, 1);
  assert.match(paid.quantityReason, /paid/);
  assert.equal(paid.worstCaseWei, (1_000_000_000_000_000n + 250_000n * 2_000_000_000n).toString());
});

test('the preview refuses what the executor would refuse, and warns about risk', () => {
  // No on-chain plan yet: the job can still be queued, but the preview says so.
  const unknown = previewJob({ ...base, entry: null });
  assert.equal(unknown.ok, true);
  assert.ok(unknown.warnings.some((warning) => /no on-chain plan/.test(warning)));

  // A non-SeaDrop target is a hard no.
  const notApplicable = previewJob({ ...base, entry: { mintPriceWei: null, capPerWallet: null, codeHash: null, publicStart: null, applicable: false } });
  assert.equal(notApplicable.ok, false);
  assert.match(notApplicable.reason, /not a SeaDrop/);

  const risky = previewJob({ ...base, riskFlags: ['instant-sellout'], entry: { mintPriceWei: '0', capPerWallet: 1, codeHash: '0x' + 'ab'.repeat(32), publicStart: 1_700_000_000 } });
  assert.equal(risky.quantity, 1, 'a risky target takes one ticket');
  assert.ok(risky.warnings.some((warning) => /instant-sellout/.test(warning)));
});

test('two jobs opening within seconds are a conflict the operator should see', () => {
  const existing = [
    { id: 'job-1', chain: 'robinhood', contract: W, startAtMs: 1_700_000_003_000, status: 'queued' },
    { id: 'job-2', chain: 'robinhood', contract: W, startAtMs: 1_700_000_500_000, status: 'queued' },
    { id: 'job-3', chain: 'arc', contract: W, startAtMs: 1_700_000_003_000, status: 'done' },
  ];
  const result = previewJob({ ...base, existing, entry: { mintPriceWei: '0', capPerWallet: 1, codeHash: '0x' + 'ab'.repeat(32), publicStart: 1_700_000_000 } });
  assert.deepEqual(result.conflicts, ['job-1'], 'only the queued job opening within 5s');
});

test('the queue summary counts what is about to fire and what collides', () => {
  const { summarizeQueue } = require('../dist/executor/preview');
  const now = 1_700_000_000_000;
  const summary = summarizeQueue(
    [
      { startAtMs: now + 60_000, status: 'queued' },
      { startAtMs: now + 63_000, status: 'queued' }, // 3s after the first: a collision
      { startAtMs: now + 30 * 60_000, status: 'claimed' },
      { startAtMs: now + 10 * 60_000, status: 'done' }, // finished: ignored
      { startAtMs: now + 90 * 60_000, status: 'queued' }, // outside the 45-minute window
    ],
    now
  );
  assert.equal(summary.dueSoon, 3);
  assert.equal(summary.conflicts, 1);
  assert.deepEqual(summarizeQueue([], now), { dueSoon: 0, conflicts: 0 });
});
