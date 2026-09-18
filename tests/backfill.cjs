const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseEther } = require('../node_modules/ethers');
const {
  dueCheckpoints,
  computeCost,
  parseStats,
  runBackfill,
  backfillKey,
  loadBackfill,
} = require('../dist/scan/backfill');

const NOW = Date.parse('2026-09-20T00:00:00.000Z');

const ledger = (over = {}) => ({
  version: 1,
  entries: {
    arc: {
      '0xabc': {
        status: 'SUCCESS',
        txHash: '0xtx',
        at: '2026-09-16T00:00:00.000Z',
        quantity: 2,
        slug: 'x',
        attempts: 1,
        ...over,
      },
    },
  },
});

test('dueCheckpoints selects only reached, unrecorded checkpoints', () => {
  assert.deepEqual(dueCheckpoints(ledger(), [], NOW, [24, 72]).map(d => d.checkpointHours), [24, 72]);
  const recorded = [{ chain: 'arc', contract: '0xABC', checkpointHours: 24 }];
  assert.deepEqual(dueCheckpoints(ledger(), recorded, NOW, [24, 72]).map(d => d.checkpointHours), [72]);
  assert.deepEqual(dueCheckpoints(ledger({ at: '2026-09-19T12:00:00.000Z' }), [], NOW, [24]), []);
  assert.deepEqual(dueCheckpoints(ledger({ status: 'REVERTED' }), [], NOW, [24]), []);
  assert.equal(backfillKey('arc', '0xABC', 24), 'arc|0xabc|24');
});

test('computeCost adds gas to the mint value', () => {
  assert.equal(computeCost(10n ** 16n, 100_000n, 2n * 10n ** 9n), 10n ** 16n + 2n * 10n ** 14n);
  assert.equal(computeCost(0n, 0n, 0n), 0n);
});

test('parseStats reads the v2 total block and the one-day interval', () => {
  const stats = parseStats({
    total: { floor_price: 0.05, floor_price_symbol: 'ETH', volume: 1 },
    intervals: [{ interval: 'one_day', volume: 0.5, sales: 3 }],
  });
  assert.equal(stats.floorPriceWei, parseEther('0.05'));
  assert.equal(stats.floorSymbol, 'ETH');
  assert.equal(stats.volume24hWei, parseEther('0.5'));
  assert.equal(stats.sales24h, 3);
  assert.deepEqual(parseStats({}), {
    floorPriceWei: null,
    floorSymbol: null,
    volume24hWei: null,
    sales24h: null,
  });
});

test('runBackfill writes per-checkpoint records and stays idempotent', async () => {
  const file = path.join(os.tmpdir(), `backfill-${Date.now()}.jsonl`);
  const deps = {
    now: () => NOW,
    loadReceipt: async () => ({ valueWei: 10n ** 16n, gasUsed: 100_000n, effectiveGasPrice: 2n * 10n ** 9n }),
    fetchStats: async () => ({ floorPriceWei: 3n * 10n ** 16n, floorSymbol: 'ETH', volume24hWei: 0n, sales24h: 1 }),
  };
  try {
    const first = await runBackfill(ledger(), { ledgerPath: 'unused', file, deps });
    assert.equal(first.due, 2);
    assert.equal(first.written, 2);
    const records = loadBackfill(file);
    assert.equal(records.length, 2);
    assert.equal(records[0].costWei, (10n ** 16n + 2n * 10n ** 14n).toString());
    assert.equal(records[0].floorPriceWei, (3n * 10n ** 16n).toString());
    assert.equal(
      records[0].netWei,
      (3n * 10n ** 16n * 2n - (10n ** 16n + 2n * 10n ** 14n)).toString()
    );

    const second = await runBackfill(ledger(), { ledgerPath: 'unused', file, deps });
    assert.equal(second.due, 0);
    assert.equal(second.written, 0);

    fs.rmSync(file, { force: true });
    const noStats = await runBackfill(ledger(), {
      ledgerPath: 'unused',
      file,
      deps: { ...deps, fetchStats: async () => null },
    });
    assert.equal(noStats.written, 2);
    assert.equal(noStats.withoutStats, 2);
    assert.equal(loadBackfill(file)[0].floorPriceWei, null);
    assert.equal(loadBackfill(file)[0].netWei, null);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('a checkpoint with neither receipt nor stats is retried, not recorded', async () => {
  const file = path.join(os.tmpdir(), `backfill-none-${Date.now()}.jsonl`);
  try {
    const summary = await runBackfill(ledger(), {
      ledgerPath: 'unused',
      file,
      deps: {
        now: () => NOW,
        loadReceipt: async () => null,
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
