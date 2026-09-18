const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseEther, parseUnits } = require('../node_modules/ethers');
const {
  dueCheckpoints,
  computeCost,
  parseStats,
  parsePricing,
  usdPriceFor,
  runBackfill,
  backfillKey,
  loadBackfill,
  formatNetUsd,
} = require('../dist/scan/backfill');
const { decodeOrderFulfilled, aggregateSales } = require('../dist/scan/seaport');
const fixture = require('./fixtures/orderfulfilled-v16.json');

const NOW = Date.parse('2026-09-20T00:00:00.000Z');
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const NATIVE = '0x0000000000000000000000000000000000000000';

const ledger = (over = {}) => ({
  version: 1,
  entries: {
    robinhood: {
      '0xabc': {
        status: 'SUCCESS',
        txHash: '0xtx',
        at: '2026-09-16T00:00:00.000Z',
        quantity: 2,
        slug: 'catonchain',
        attempts: 1,
        ...over,
      },
    },
  },
});

test('decodes a captured Seaport 1.6 OrderFulfilled log', () => {
  const sale = decodeOrderFulfilled(fixture.log);
  assert.equal(sale.block, fixture.expected.block);
  assert.equal(sale.nft, fixture.expected.nft);
  assert.equal(sale.identifier, fixture.expected.identifier);
  assert.equal(sale.buyer, fixture.expected.buyer);
  assert.equal(sale.payToken, fixture.expected.payToken);
  assert.equal(sale.amountAtomic.toString(), fixture.expected.amountAtomic);
  assert.equal(decodeOrderFulfilled({ ...fixture.log, data: '0x1234' }), null);
});

test('aggregates recent sales per currency with low/median and unique buyers', () => {
  const base = decodeOrderFulfilled(fixture.log);
  const sales = [
    { ...base, block: 100, amountAtomic: 500_000n, buyer: '0xa' },
    { ...base, block: 101, amountAtomic: 300_000n, buyer: '0xb' },
    { ...base, block: 102, amountAtomic: 400_000n, buyer: '0xb' },
    { ...base, block: 90, payToken: NATIVE, amountAtomic: 10n ** 18n, buyer: '0xc' },
  ];
  const stats = aggregateSales(sales, 4);
  assert.equal(stats.payToken, USDG);
  assert.equal(stats.count, 3);
  assert.equal(stats.lowAtomic, 300_000n);
  assert.equal(stats.medianAtomic, 400_000n);
  assert.equal(stats.uniqueBuyers, 2);
  assert.equal(stats.mixedCurrencies, true);
  assert.equal(aggregateSales([], 3), null);
  // Only the recent window counts: the older native sale is outside maxSales=3.
  assert.equal(aggregateSales(sales, 3).mixedCurrencies, false);
});

test('dueCheckpoints selects only reached, unrecorded checkpoints', () => {
  assert.deepEqual(dueCheckpoints(ledger(), [], NOW, [24, 72]).map(d => d.checkpointHours), [24, 72]);
  const recorded = [{ chain: 'robinhood', contract: '0xABC', checkpointHours: 24 }];
  assert.deepEqual(dueCheckpoints(ledger(), recorded, NOW, [24, 72]).map(d => d.checkpointHours), [72]);
  assert.deepEqual(dueCheckpoints(ledger({ at: '2026-09-19T12:00:00.000Z' }), [], NOW, [24]), []);
  assert.deepEqual(dueCheckpoints(ledger({ status: 'REVERTED' }), [], NOW, [24]), []);
  assert.equal(backfillKey('robinhood', '0xABC', 24), 'robinhood|0xabc|24');
});

test('computeCost adds gas to the mint value', () => {
  assert.equal(computeCost(10n ** 16n, 100_000n, 2n * 10n ** 9n), 10n ** 16n + 2n * 10n ** 14n);
  assert.equal(computeCost(0n, 0n, 0n), 0n);
});

test('parseStats honours the listing currency decimals (USDG uses 6)', () => {
  const stats = parseStats({ total: { floor_price: 0.3, floor_price_symbol: 'USDG' }, intervals: [{ interval: 'one_day', volume: 12.5, sales: 4 }] }, 6);
  assert.equal(stats.floorAtomic, parseUnits('0.3', 6));
  assert.equal(stats.volume24hAtomic, parseUnits('12.5', 6));
  assert.equal(stats.sales24h, 4);
  assert.equal(stats.floorSymbol, 'USDG');
  const eighteen = parseStats({ total: { floor_price: 0.05 } }, 18);
  assert.equal(eighteen.floorAtomic, parseEther('0.05'));
});

test('parsePricing derives ETH/USD from either currency and maps token prices', () => {
  const catonchain = parsePricing({
    pricing_currencies: {
      listing_currency: { symbol: 'USDG', address: USDG, decimals: 6, usd_price: '0.999874', eth_price: '0.000402757626169655' },
      offer_currency: { symbol: 'USDG', address: USDG, decimals: 6, usd_price: '0.999874', eth_price: '0.000402757626169655' },
    },
  });
  assert.equal(catonchain.listing.decimals, 6);
  assert.ok(Math.abs(catonchain.ethUsd - 2482.57) < 1);
  assert.equal(usdPriceFor(catonchain, USDG), 0.999874);
  assert.equal(usdPriceFor(catonchain, NATIVE), catonchain.ethUsd);

  const hood = parsePricing({
    pricing_currencies: { listing_currency: { symbol: 'ETH', address: NATIVE, decimals: 18, usd_price: '2484.78', eth_price: '1' } },
  });
  assert.equal(hood.ethUsd, 2484.78);
  assert.equal(usdPriceFor(hood, NATIVE), 2484.78);
  assert.equal(usdPriceFor(hood, USDG), null);
});

test('runBackfill prefers Seaport sales, converts to USD, and stays idempotent', async () => {
  const file = path.join(os.tmpdir(), `backfill-${Date.now()}.jsonl`);
  const deps = {
    now: () => NOW,
    loadReceipt: async () => ({ valueWei: 0n, gasUsed: 100_000n, effectiveGasPrice: 2n * 10n ** 9n }),
    fetchSales: async () => ({
      count: 5,
      lowAtomic: 300_000n,
      medianAtomic: 400_000n,
      uniqueBuyers: 3,
      payToken: USDG,
      latestBlock: 1,
      mixedCurrencies: false,
    }),
    erc20Meta: async () => ({ decimals: 6, symbol: 'USDG' }),
    fetchPricing: async () => parsePricing({ pricing_currencies: { listing_currency: { symbol: 'USDG', address: USDG, decimals: 6, usd_price: '1', eth_price: '0.0004' } } }),
    fetchStats: async () => null,
  };
  try {
    const first = await runBackfill(ledger(), { ledgerPath: 'unused', file, deps });
    assert.equal(first.due, 2);
    assert.equal(first.written, 2);
    assert.equal(first.withoutFloor, 0);

    const records = loadBackfill(file);
    assert.equal(records[0].floorSource, 'seaport');
    assert.equal(records[0].floorAtomic, '300000');
    assert.equal(records[0].floorDecimals, 6);
    assert.equal(records[0].floorSymbol, 'USDG');
    assert.equal(records[0].costWei, (2n * 10n ** 14n).toString());
    // cost 0.0002 ETH at 2500 USD/ETH = $0.5; floor 0.3 USDG x 2 = $0.6 -> net $0.1
    assert.ok(Math.abs(records[0].floorUsd - 0.3) < 1e-9);
    assert.ok(Math.abs(records[0].costUsd - 0.5) < 1e-9);
    assert.ok(Math.abs(records[0].netUsd - 0.1) < 1e-9);
    assert.equal(formatNetUsd(records[0]), '$0.1000');

    const second = await runBackfill(ledger(), { ledgerPath: 'unused', file, deps });
    assert.equal(second.due, 0);

    fs.rmSync(file, { force: true });
    // Falls back to OpenSea stats when the chain has no sales for the collection.
    const fallback = await runBackfill(ledger(), {
      ledgerPath: 'unused',
      file,
      deps: { ...deps, fetchSales: async () => null, fetchStats: async () => ({ floorAtomic: 500_000n, floorSymbol: 'USDG', volume24hAtomic: null, sales24h: 2 }) },
    });
    assert.equal(fallback.written, 2);
    assert.equal(loadBackfill(file)[0].floorSource, 'opensea');
    assert.equal(loadBackfill(file)[0].floorAtomic, '500000');
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('a failed sales scan is reported, not treated as no-sales', async () => {
  const file = path.join(os.tmpdir(), `backfill-err-${Date.now()}.jsonl`);
  try {
    const summary = await runBackfill(ledger(), {
      ledgerPath: 'unused',
      file,
      deps: {
        now: () => NOW,
        loadReceipt: async () => ({ valueWei: 0n, gasUsed: 1n, effectiveGasPrice: 1n }),
        fetchSales: async () => {
          throw new Error('Too Many Requests');
        },
        erc20Meta: async () => null,
        fetchPricing: async () => null,
        fetchStats: async () => null,
      },
    });
    assert.equal(summary.written, 2);
    assert.equal(summary.withoutFloor, 2);
    assert.ok(summary.errors.some(e => e.includes('seaport scan failed') && e.includes('Too Many Requests')));
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('a checkpoint with neither receipt nor floor is retried, not recorded', async () => {
  const file = path.join(os.tmpdir(), `backfill-none-${Date.now()}.jsonl`);
  try {
    const summary = await runBackfill(ledger(), {
      ledgerPath: 'unused',
      file,
      deps: {
        now: () => NOW,
        loadReceipt: async () => null,
        fetchSales: async () => null,
        erc20Meta: async () => null,
        fetchPricing: async () => null,
        fetchStats: async () => null,
      },
    });
    assert.equal(summary.due, 2);
    assert.equal(summary.written, 0);
    assert.equal(summary.errors.length, 2);
    assert.equal(fs.existsSync(file), false);
  } finally {
    fs.rmSync(file, { force: true });
  }
});
