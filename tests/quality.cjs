const { test } = require('node:test');
const assert = require('node:assert/strict');
const { aggregateCreators, qualityScore, safeImageUrl, safeLinkUrl } = require('../dist/scan/quality');

const now = 1_758_000_000;

test('aggregateCreators groups per-owner history and overlays our own evidence', () => {
  const facts = [
    { owner: '0xOwner', chain: 'arc', contract: '0x1', soldOut: true, maxSupply: 100n, minted: 100n, velocity24h: 20n },
    { owner: '0xOwner', chain: 'arc', contract: '0x2', soldOut: false, maxSupply: 100n, minted: 10n, velocity24h: 40n },
    { owner: null, chain: 'arc', contract: '0x9', soldOut: false, maxSupply: 10n, minted: 0n, velocity24h: null },
    { owner: '0xOther', chain: 'arc', contract: '0x3', soldOut: false, maxSupply: null, minted: null, velocity24h: null },
  ];
  const backfills = [
    { chain: 'arc', contract: '0x1', checkpointHours: 1, salesCount: 2, netUsd: 0.5 },
    { chain: 'arc', contract: '0x1', checkpointHours: 6, salesCount: 7, netUsd: 1.5 },
    { chain: 'arc', contract: '0x2', checkpointHours: 6, salesCount: 3, netUsd: null },
  ];
  const ledger = {
    version: 1,
    entries: { arc: { '0x1': { status: 'SUCCESS', txHash: '0xdead', at: 'x', quantity: 2, slug: null, attempts: 1 } } },
  };

  const stats = aggregateCreators(facts, backfills, ledger);
  const owner = stats.get('0xowner');
  assert.equal(owner.dropCount, 2);
  assert.equal(owner.soldOutRate, 0.5);
  assert.equal(owner.avgVelocity24h, 30);
  assert.equal(owner.salesCount, 10); // latest checkpoint per contract: 7 + 3
  assert.equal(owner.ownMints, 2);
  assert.equal(owner.ownNetUsd, 1.5); // latest checkpoint (6h), not the 1h one
  assert.equal(owner.ownData, true);

  const other = stats.get('0xother');
  assert.equal(other.dropCount, 1);
  assert.equal(other.soldOutRate, null);
  assert.equal(other.avgVelocity24h, null);
  assert.equal(other.salesCount, null);
  assert.equal(other.ownMints, 0);
  assert.equal(other.ownNetUsd, null);
  assert.equal(other.ownData, false);

  assert.equal(stats.has('0x9'), false, 'ownerless contracts are not a creator');
});

const strongCreator = {
  owner: '0xowner',
  dropCount: 6,
  soldOutRate: 1,
  avgVelocity24h: 120,
  salesCount: 10,
  ownMints: 2,
  ownNetUsd: 1.5,
  ownData: true,
};

const strongSignals = {
  phase: 'live-fresh',
  stale: false,
  mintPriceWei: '0',
  startSec: now - 3600,
  endSec: now - 3600 + 86_400,
  nowSec: now,
  maxSupply: 1000n,
  minted: 500n,
  remaining: 500n,
  velocity24h: 20n, // 2% of supply per day
  uniqueMinters: 60,
  topMinterShare: 0.1,
  presaleStages: 1,
  capPerWallet: 2,
  creator: strongCreator,
  social: { twitter: 'x', discord: 'u', website: 'u', createdDate: '2020-01-01T00:00:00.000Z', safelist: 'approved' },
};

test('qualityScore rates a fully known strong target at 100 with full confidence', () => {
  const result = qualityScore(strongSignals);
  assert.equal(result.score, 100);
  assert.equal(result.confidence, 1);
  assert.deepEqual(result.dimensions, { demand: 100, participation: 100, creator: 100, social: 100, structure: 100 });
  assert.deepEqual(result.penalties, []);
});

test('qualityScore returns null when nothing is known', () => {
  const result = qualityScore({
    phase: 'unaudited',
    stale: false,
    mintPriceWei: null,
    startSec: null,
    endSec: null,
    nowSec: now,
    maxSupply: null,
    minted: null,
    remaining: null,
    velocity24h: null,
    uniqueMinters: null,
    topMinterShare: null,
    presaleStages: null,
    capPerWallet: null,
    creator: null,
    social: null,
  });
  assert.equal(result.score, null);
  assert.equal(result.confidence, 0);
  assert.deepEqual(result.penalties, []);
});

test('qualityScore scores only known dimensions and lowers confidence accordingly', () => {
  const result = qualityScore({
    ...strongSignals,
    velocity24h: null,
    maxSupply: null,
    minted: null,
    remaining: null,
    uniqueMinters: null,
    topMinterShare: null,
    presaleStages: 0,
    capPerWallet: 0,
    startSec: now + 86_400 * 30,
    endSec: now + 86_400 * 60, // 30-day window: no structure credit either
    creator: null,
    social: { twitter: null, discord: null, website: null, createdDate: null, safelist: null },
  });
  // social 0 (known but empty) and structure 0 (no presale, no cap, month-long window)
  assert.equal(result.score, 0);
  assert.equal(result.confidence, 0.3);
  assert.equal(result.dimensions.demand, null);
  assert.equal(result.dimensions.participation, null);
  assert.equal(result.dimensions.creator, null);
  assert.ok(result.penalties.includes('no-socials'));
});

test('qualityScore reports penalties and punishes concentrated mints', () => {
  const result = qualityScore({ ...strongSignals, stale: true, topMinterShare: 0.8 });
  assert.ok(result.penalties.includes('stale'));
  assert.ok(result.penalties.includes('concentrated'));
  assert.equal(result.dimensions.participation, 0);
});

test('own-data evidence raises confidence without inflating the score', () => {
  const partial = {
    ...strongSignals,
    velocity24h: null,
    maxSupply: null,
    minted: null,
    remaining: null,
    uniqueMinters: null,
  };
  const withData = qualityScore(partial);
  const without = qualityScore({
    ...partial,
    creator: { ...strongCreator, ownData: false, ownMints: 0, ownNetUsd: null },
  });
  assert.equal(withData.score, without.score);
  assert.ok(withData.confidence > without.confidence);
});

test('safeImageUrl only allows https images from the OpenSea CDNs', () => {
  assert.equal(safeImageUrl('https://i.seadn.io/abc.png'), 'https://i.seadn.io/abc.png');
  assert.equal(safeImageUrl('https://opensea.io/static/x.png'), 'https://opensea.io/static/x.png');
  assert.equal(safeImageUrl('http://i.seadn.io/abc.png'), null);
  assert.equal(safeImageUrl('https://i.seadn.io.evil.com/abc.png'), null);
  assert.equal(safeImageUrl('https://evil.com/abc.png'), null);
  assert.equal(safeImageUrl('javascript:alert(1)'), null);
  assert.equal(safeImageUrl(null), null);
});

test('safeLinkUrl only allows http(s) links', () => {
  assert.equal(safeLinkUrl('https://x.com/foo'), 'https://x.com/foo');
  assert.equal(safeLinkUrl('http://example.com'), 'http://example.com/'); // normalised by URL()
  assert.equal(safeLinkUrl('javascript:alert(1)'), null);
  assert.equal(safeLinkUrl('  '), null);
});
