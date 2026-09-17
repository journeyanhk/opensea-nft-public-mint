const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { mergeRawConfigs, rawTargetKey, diffKeys } = require('../dist/batch-watch');
const {
  emptyLedger,
  loadLedger,
  saveLedger,
  recordEntry,
  entryOf,
  shouldSkipLedger,
} = require('../dist/batch-ledger');

test('merges watched configs with the main file first and no duplicate targets', () => {
  const main = { chain: 'robinhood', targets: [{ slug: '0xAAA' }, { slug: ' 0xbbb ' }], gas: { maxFeeGwei: 2 } };
  const extra = { chain: 'robinhood', targets: [{ slug: '0xaaa' }, { slug: '0xccc' }] };
  const merged = mergeRawConfigs(main, [extra]);
  assert.deepEqual(merged.targets.map(t => t.slug), ['0xAAA', ' 0xbbb ', '0xccc']);
  assert.equal(merged.gas.maxFeeGwei, 2);
  assert.throws(() => mergeRawConfigs(main, [{ chain: 'arc' }]));
});

test('raw target identity is case- and whitespace-insensitive', () => {
  assert.equal(rawTargetKey({ slug: '  0xAbC  ' }), '0xabc');
  assert.equal(rawTargetKey({}), '');
});

test('diffKeys reports additions and removals', () => {
  const { added, removed } = diffKeys(new Set(['a', 'b']), new Set(['b', 'c']));
  assert.deepEqual(added, ['c']);
  assert.deepEqual(removed, ['a']);
  assert.deepEqual(diffKeys(new Set(), new Set()), { added: [], removed: [] });
});

test('ledger round-trips through an atomic write', () => {
  const file = path.join(os.tmpdir(), `ledger-${Date.now()}.json`);
  try {
    const ledger = emptyLedger();
    recordEntry(ledger, 'robinhood', '0xABC', {
      status: 'SUCCESS',
      txHash: '0x1',
      at: '2026-09-17T08:00:00.000Z',
      quantity: 2,
      slug: 'x',
    });
    saveLedger(ledger, file);
    const loaded = loadLedger(file);
    assert.equal(entryOf(loaded, 'robinhood', '0xabc').status, 'SUCCESS');
    assert.equal(entryOf(loaded, 'robinhood', '0xABC').quantity, 2);
  } finally {
    fs.rmSync(file, { force: true });
  }
  assert.deepEqual(loadLedger(path.join(os.tmpdir(), `missing-${Date.now()}.json`)), emptyLedger());
});

test('skip rules: anything that may have reached the chain is not sent again', () => {
  const entry = over => ({
    status: 'PENDING',
    txHash: null,
    at: '2026-09-17T08:00:00.000Z',
    quantity: 1,
    slug: null,
    ...over,
  });
  assert.equal(shouldSkipLedger(undefined), false);
  assert.equal(shouldSkipLedger(entry({ status: 'SUCCESS', txHash: '0x1' })), true);
  assert.equal(shouldSkipLedger(entry({ status: 'REVERTED', txHash: '0x1' })), true);
  assert.equal(shouldSkipLedger(entry({ status: 'TIMEOUT', txHash: '0x1' })), true);
  assert.equal(shouldSkipLedger(entry({ status: 'PENDING' })), true);
  assert.equal(shouldSkipLedger(entry({ status: 'PENDING' }), { retryPending: true }), false);
  assert.equal(shouldSkipLedger(entry({ status: 'SKIPPED' })), false);
  assert.equal(shouldSkipLedger(entry({ status: 'REJECTED' })), false);
  assert.equal(shouldSkipLedger(entry({ status: 'REJECTED', txHash: '0x1' })), true);
});
