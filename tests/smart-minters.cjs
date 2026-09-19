const { test } = require('node:test');
const assert = require('node:assert/strict');
const { smartCandidates, addSmartCandidates, smartSet, smartOverlap, emptySmartStore } = require('../dist/scan/smart-minters');

test('smartCandidates keeps wallets that filled the cap or minted repeatedly', () => {
  const walletMints = [
    { address: '0xA', tokens: 10n },
    { address: '0xB', tokens: 9n },
    { address: '0xC', tokens: 3n },
    { address: '0xD', tokens: 2n },
  ];
  // With a known cap, only wallets that filled it count.
  assert.deepEqual(smartCandidates(walletMints, 10), ['0xa']);
  // Without one, repeated mints stand in.
  assert.deepEqual(smartCandidates(walletMints, null), ['0xa', '0xb', '0xc']);
});

test('addSmartCandidates qualifies on the second appearance and smartSet filters the rest', () => {
  const store = emptySmartStore();
  addSmartCandidates(store, ['0xA'], 'robinhood|0x1', 't1');
  assert.equal(smartSet(store).size, 0, 'a single appearance is not yet a signal');
  addSmartCandidates(store, ['0xa'], 'robinhood|0x2', 't2');
  const set = smartSet(store);
  assert.ok(set.has('0xa'));
  assert.equal(store.minters['0xa'].appearances, 2);
  assert.deepEqual(store.minters['0xa'].drops, ['robinhood|0x1', 'robinhood|0x2']);
});

test('smartOverlap counts how many of a target top minters the set knows', () => {
  const set = new Set(['0xa', '0xc']);
  assert.equal(smartOverlap([{ address: '0xA', tokens: 1n }, { address: '0xB', tokens: 1n }, { address: '0xC', tokens: 1n }], set), 2);
  assert.equal(smartOverlap([{ address: '0xB', tokens: 1n }], set), 0);
});
