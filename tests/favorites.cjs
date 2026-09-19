const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  favoriteKey, emptyFavorites, upsertFavorite, removeFavorite, toJsonl, loadFavorites, saveFavorites,
} = require('../dist/scan/favorites');

const snapshot = {
  at: '2026-09-19T09:00:00.000Z', grade: 'A', q: 76, confidence: 1, phase: 'upcoming',
  start: 1_758_000_000, mintPriceWei: '0', remaining: '500', maxSupply: '1000', minted: '500',
  velocity24h: '480', uniqueMinters: 80, topMinterShare: 0.1, smartMinters: 4, batchMint: false,
  penalties: ['no-socials'], calendarListed: true, creatorDropCount: 1,
};

test('favoriteKey normalises chain and contract', () => {
  assert.equal(favoriteKey('Robinhood', '0xAbC'), 'robinhood|0xabc');
});

test('upsertFavorite keeps addedAt and merges only provided edits', () => {
  const store = emptyFavorites();
  const first = upsertFavorite(store, { chain: 'robinhood', contract: '0xAbC', slug: 'cool', name: 'Cool', snapshot }, '2026-09-19T09:00:00.000Z');
  assert.equal(first.addedAt, '2026-09-19T09:00:00.000Z');
  assert.equal(first.status, 'watching', 'a new favorite starts as watching');
  assert.equal(first.note, '');

  const edited = upsertFavorite(store, { chain: 'robinhood', contract: '0xabc', status: 'ready', note: 'creator sold out twice' }, '2026-09-19T10:00:00.000Z');
  assert.equal(edited.addedAt, '2026-09-19T09:00:00.000Z', 'addedAt is immutable');
  assert.equal(edited.updatedAt, '2026-09-19T10:00:00.000Z');
  assert.equal(edited.status, 'ready');
  assert.equal(edited.note, 'creator sold out twice');
  assert.equal(edited.slug, 'cool', 'unspecified fields survive an edit');
  assert.equal(edited.snapshot.q, 76, 'the snapshot is kept for later analysis');

  // Re-adding must not overwrite the first snapshot.
  const readded = upsertFavorite(store, { chain: 'robinhood', contract: '0xabc', snapshot: { ...snapshot, q: 10 } }, '2026-09-19T11:00:00.000Z');
  assert.equal(readded.snapshot.q, 76);
});

test('removeFavorite reports whether anything was removed', () => {
  const store = emptyFavorites();
  upsertFavorite(store, { chain: 'robinhood', contract: '0x1' }, 't');
  assert.equal(removeFavorite(store, 'Robinhood', '0x1'), true);
  assert.equal(removeFavorite(store, 'robinhood', '0x1'), false);
  assert.deepEqual(Object.keys(store.favorites), []);
});

test('toJsonl is the analysis export: one labelled row per favorite', () => {
  const store = emptyFavorites();
  upsertFavorite(store, { chain: 'robinhood', contract: '0x1', slug: 'a', name: 'A', note: 'good', snapshot }, '2026-09-19T09:00:00.000Z');
  upsertFavorite(store, { chain: 'arc', contract: '0x2', name: 'B' }, '2026-09-19T09:10:00.000Z');
  const lines = toJsonl(store).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines.length, 2);
  const a = lines.find((row) => row.contract === '0x1');
  assert.equal(a.key, 'robinhood|0x1');
  assert.equal(a.note, 'good');
  assert.equal(a.snapshot.q, 76);
  assert.equal(lines.find((row) => row.contract === '0x2').snapshot, null, 'a favorite without a snapshot still exports');
});

test('loadFavorites tolerates missing, corrupt and foreign files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fav-'));
  const file = path.join(dir, '.favorites.json');
  assert.deepEqual(loadFavorites(file), emptyFavorites(), 'missing file is empty, not an error');
  fs.writeFileSync(file, 'not json');
  assert.deepEqual(loadFavorites(file), emptyFavorites(), 'corrupt file is empty, not a crash');
  fs.writeFileSync(file, JSON.stringify({ version: 2, favorites: {} }));
  assert.deepEqual(loadFavorites(file), emptyFavorites(), 'a future version is ignored');
});

test('saveFavorites writes atomically and round-trips', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fav-'));
  const file = path.join(dir, '.favorites.json');
  const store = emptyFavorites();
  upsertFavorite(store, { chain: 'robinhood', contract: '0x1', name: 'A', snapshot }, '2026-09-19T09:00:00.000Z');
  saveFavorites(store, file);
  assert.equal(fs.existsSync(`${file}.tmp`), false, 'no temp file is left behind');
  const loaded = loadFavorites(file);
  assert.equal(loaded.favorites['robinhood|0x1'].snapshot.q, 76);
});
