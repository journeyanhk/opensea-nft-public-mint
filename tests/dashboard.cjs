const { test } = require('node:test');
const assert = require('node:assert/strict');
const { escapeHtml, loadDashboardRows, parseHistory, renderDashboard } = require('../dist/scan/html');

const start = 1_758_000_000;

const state = {
  version: 1,
  chains: {},
  contracts: {
    arc: {
      '0xabc': {
        firstSeenBlock: 1,
        lastSeenBlock: 10,
        lastAuditedBlock: 10,
        lastAuditedAt: '2026-09-17T08:00:00.000Z',
        lastGrade: 'B',
        soldOutAtBlock: null,
        publicStart: start,
        pendingAudit: true,
      },
    },
  },
};

const history = [
  { at: '2026-09-17T07:00:00.000Z', chain: 'arc', contract: '0xAbC', grade: 'C', remaining: '0', projected: '0', start, risks: ['partial scan (1% of mints)'] },
  { at: '2026-09-17T08:00:00.000Z', chain: 'arc', contract: '0xabc', grade: 'B', remaining: '50', projected: '20', start, risks: ['top minter holds 80%', 'price changed 8m before open'] },
];

const ledger = {
  version: 1,
  entries: {
    arc: {
      '0xabc': { status: 'SUCCESS', txHash: '0xdead', at: '2026-09-17T09:00:00.000Z', quantity: 1, slug: 'x', attempts: 1 },
    },
  },
};

const cached = {
  mintScan: {
    stages: [{ stage: 0, txs: 2, tokens: 5n, uniqueMinters: 2, topMinterTokens: 4n, firstBlock: 1, lastBlock: 2, price: 0n }],
    totalTxs: 2,
    totalTokens: 5n,
    uniqueMinters: 2,
    topMinterShare: 0.8,
    firstBlock: 1,
    lastBlock: 2,
    recentTokens: 5n,
  },
  updates: [
    { block: 1, price: 1n, startTime: start - 1000, endTime: start + 1000, cap: 1, at: start - 600 },
    { block: 2, price: 2n, startTime: start - 1000, endTime: start + 1000, cap: 1, at: start - 500 },
  ],
  scannedAt: 1,
};

test('parses history lines and tolerates a torn last line', () => {
  const text = [
    JSON.stringify(history[0]),
    '',
    JSON.stringify(history[1]),
    '{"at":"2026-09-17T09:00:00Z","chain":"arc","contr',
  ].join('\n');
  assert.equal(parseHistory(text).length, 2);
  assert.equal(parseHistory('').length, 0);
});

test('merges state, history, ledger and cache into dashboard rows', () => {
  const rows = loadDashboardRows(state, history, ledger, () => cached);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.contract, '0xabc');
  assert.equal(row.grade, 'B');
  assert.equal(row.gradeHistory.length, 2);
  assert.equal(row.remaining, '50');
  assert.equal(row.projected, '20');
  assert.equal(row.start, start);
  assert.equal(row.pendingAudit, true);
  assert.equal(row.execution.status, 'SUCCESS');
  assert.equal(row.execution.txHash, '0xdead');
  assert.deepEqual(row.stages, [{ stage: 0, tokens: '5', minters: 2 }]);
  assert.ok(row.notes.includes('queued (over limit)'));
  // Risk labels come verbatim from the last audit, not from a second derivation.
  assert.ok(row.notes.includes('top minter holds 80%'));
  assert.ok(row.notes.includes('price changed 8m before open'));
});

test('rows without cache or ledger degrade instead of failing', () => {
  const rows = loadDashboardRows(state, history, { version: 1, entries: {} }, () => null);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].execution, null);
  assert.deepEqual(rows[0].stages, []);
  assert.equal(rows[0].topMinterShare, null);
  // Risk labels are the audit's own output, so they survive a missing cache.
  assert.ok(rows[0].notes.includes('top minter holds 80%'));
});

test('escapes every dynamic field in the rendered HTML', () => {
  assert.equal(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  const rows = loadDashboardRows(state, history, ledger, () => cached);
  rows[0].contract = '<script>alert(1)</script>';
  rows[0].notes = ['<img src=x onerror=alert(1)>'];
  const html = renderDashboard(rows, { generatedAt: 'now', sources: ['a.json'] });
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(!html.includes('<img src=x onerror=alert(1)>'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('data-grade="B"'));
  assert.ok(html.includes('0xdead'));
});

test('backfill records surface as net columns', () => {
  const backfills = [
    { chain: 'arc', contract: '0xABC', checkpointHours: 24, netUsd: 0.05 },
    { chain: 'arc', contract: '0xabc', checkpointHours: 72, netUsd: 0.02 },
    { chain: 'arc', contract: '0xabc', checkpointHours: 168, netUsd: 0.01 },
  ];
  const rows = loadDashboardRows(state, history, ledger, () => cached, backfills);
  assert.deepEqual(rows[0].nets, { '24': '$0.0500', '72': '$0.0200', '168': '$0.0100' });
  const html = renderDashboard(rows, { generatedAt: 'now', sources: [] });
  assert.ok(html.includes('data-net24="$0.0500"'));
  assert.ok(html.includes('24h net'));
});

const {
  velocityPer24h,
  staleVerdict,
  sellOutEtaHours,
} = require('../dist/scan/html');

test('24h velocity uses the audit differential when the series is long enough', () => {
  const now = Date.parse('2026-09-18T12:00:00.000Z');
  const points = [
    { at: '2026-09-17T12:00:00.000Z', minted: '100' },
    { at: '2026-09-18T12:00:00.000Z', minted: '500' },
  ];
  assert.deepEqual(velocityPer24h(points, null), { per24h: 400n, source: 'differential' });

  // Too short a series falls back to the 1h bucket, labelled as an estimate.
  const short = [
    { at: '2026-09-18T10:00:00.000Z', minted: '100' },
    { at: '2026-09-18T12:00:00.000Z', minted: '500' },
  ];
  assert.deepEqual(velocityPer24h(short, 10n), { per24h: 240n, source: 'bucket' });
  assert.deepEqual(velocityPer24h([], null), { per24h: null, source: null });
  // A mint-count going backwards is not a velocity.
  const backwards = [
    { at: '2026-09-17T12:00:00.000Z', minted: '500' },
    { at: '2026-09-18T12:00:00.000Z', minted: '100' },
  ];
  assert.deepEqual(velocityPer24h(backwards, 1n), { per24h: 24n, source: 'bucket' });
});

test('stale verdict catches opened-but-dead targets only', () => {
  const now = 1_000_000_000;
  const base = { nowSec: now, maxSupply: 10_000n, velocityPer24h: 0n };
  assert.equal(staleVerdict({ ...base, startSec: now - 25 * 3600, minted: 500n }), true);
  assert.equal(staleVerdict({ ...base, startSec: now - 25 * 3600, minted: 2_000n }), false);
  assert.equal(staleVerdict({ ...base, startSec: now - 3600, minted: 100n }), false);
  assert.equal(staleVerdict({ ...base, startSec: now - 25 * 3600, minted: 100n, velocityPer24h: 100n }), false);
  assert.equal(staleVerdict({ ...base, startSec: null, minted: 100n }), false);
  assert.equal(staleVerdict({ ...base, startSec: now - 25 * 3600, minted: null }), false);
});

test('sell-out ETA needs a positive velocity', () => {
  assert.equal(sellOutEtaHours(240n, 240n), 24);
  assert.equal(sellOutEtaHours(240n, 0n), null);
  assert.equal(sellOutEtaHours(null, 240n), null);
  assert.equal(sellOutEtaHours(100n, 10_000n), 0);
});

test('new history facts surface as dashboard row fields and render', () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const richState = {
    version: 1,
    chains: {},
    contracts: {
      arc: {
        '0xfeed': {
          firstSeenBlock: 1,
          lastSeenBlock: 10,
          lastAuditedBlock: 10,
          lastAuditedAt: new Date().toISOString(),
          lastGrade: 'A',
          soldOutAtBlock: null,
          publicStart: nowSec - 7200,
          pendingAudit: false,
        },
      },
    },
  };
  const richHistory = [
    {
      at: new Date((nowSec - 24 * 3600) * 1000).toISOString(),
      chain: 'arc',
      contract: '0xfeed',
      grade: 'B',
      remaining: '9000',
      projected: '8000',
      start: nowSec - 7200,
      totalMinted: '1000',
      maxSupply: '10000',
      mintPriceWei: '0',
      capPerWallet: 2,
      endTime: nowSec + 86_400,
      name: 'Feed Token',
      owner: '0xowner',
      recent15m: '5',
      recent1h: '20',
      uniqueMinters: 42,
      presaleStages: 1,
    },
    {
      at: new Date().toISOString(),
      chain: 'arc',
      contract: '0xfeed',
      grade: 'A',
      remaining: '8000',
      projected: '7000',
      start: nowSec - 7200,
      totalMinted: '2000',
      maxSupply: '10000',
      mintPriceWei: '0',
      capPerWallet: 2,
      endTime: nowSec + 86_400,
      name: 'Feed Token',
      owner: '0xowner',
      recent15m: '10',
      recent1h: '40',
      uniqueMinters: 60,
      presaleStages: 1,
    },
  ];
  const rows = loadDashboardRows(richState, richHistory, { version: 1, entries: {} }, () => null, []);
  const row = rows[0];
  assert.equal(row.name, 'Feed Token');
  assert.equal(row.mintPriceWei, '0');
  assert.equal(row.capPerWallet, 2);
  assert.equal(row.minted, '2000');
  assert.equal(row.velocitySource, 'differential');
  assert.equal(row.velocity24h, '1000');
  assert.equal(row.stale, false);
  assert.equal(row.links.opensea, 'https://opensea.io/assets/arc/0xfeed/1');
  assert.ok(row.links.explorer.includes('/address/0xfeed'));

  const html = renderDashboard(rows, { generatedAt: 'now', sources: [] });
  assert.ok(html.includes('>FREE<'));
  assert.ok(html.includes('data-free="1"'));
  assert.ok(html.includes('data-stale="0"'));
  assert.ok(html.includes('id="presetFresh"'));
  assert.ok(html.includes('Feed Token'));
});

test('the table header and every row have the same number of columns', () => {
  const rows = loadDashboardRows(state, history, ledger, () => cached);
  const html = renderDashboard(rows, { generatedAt: 'now', sources: [] });
  const head = html.slice(html.indexOf('<thead>'), html.indexOf('</thead>'));
  const headerCount = (head.match(/<th( |>)/g) || []).length;
  const body = html.slice(html.indexOf('<tbody>'), html.indexOf('</tbody>'));
  const rowCounts = (body.match(/<tr data-chain[\s\S]*?<\/tr>/g) || []).map(
    (tr) => (tr.match(/<td/g) || []).length
  );
  assert.ok(rowCounts.length > 0);
  for (const count of rowCounts) assert.equal(count, headerCount);
  // Left (remaining) is its own column, and every sort key exists on the rows.
  assert.ok(head.includes('data-sort="remaining"'));
  assert.ok(body.includes('data-remaining='));
  for (const key of ['grade', 'chain', 'target', 'start', 'mintprice', 'mintedpct', 'remaining', 'velocity', 'stale', 'notes', 'net24usd', 'net72usd']) {
    assert.ok(head.includes(`data-sort="${key}"`), `missing sort key ${key}`);
    assert.ok(body.includes(`data-${key}=`), `missing data attribute ${key}`);
  }
});

test('fresh discoveries keep at least half the audit slots', () => {
  const { selectAuditBatch } = require('../dist/scan/scanner');
  const fresh = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10'];
  const reaudit = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10'];
  // New work is served first; re-audits fill only what is left.
  const mixed = selectAuditBatch([], fresh, 4, reaudit);
  assert.deepEqual(mixed.audit, ['f1', 'f2', 'f3', 'f4']);
  assert.equal(mixed.overflow.length, 6);
  // When nothing new is waiting, re-audits may use the whole batch.
  assert.deepEqual(selectAuditBatch([], [], 4, reaudit).audit, ['r1', 'r2', 'r3', 'r4']);
  // Pending backlog keeps its priority inside the new-work group.
  assert.deepEqual(selectAuditBatch(['p1', 'p2', 'p3'], ['f1'], 4, ['r1', 'r2']).audit, ['p1', 'p2', 'p3', 'f1']);
  // Without re-audits the previous behaviour is unchanged.
  assert.deepEqual(selectAuditBatch(['p1'], ['f1', 'f2'], 2, []), { audit: ['p1', 'f1'], overflow: ['f2'] });
});

test('a known slug is preferred for the OpenSea link', () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const slugState = {
    version: 1,
    chains: {},
    contracts: {
      robinhood: {
        '0xslug': {
          firstSeenBlock: 1,
          lastSeenBlock: 1,
          lastAuditedBlock: 1,
          lastAuditedAt: new Date().toISOString(),
          lastGrade: 'A',
          soldOutAtBlock: null,
          publicStart: nowSec - 3600,
          pendingAudit: false,
        },
      },
    },
  };
  const slugHistory = [
    { at: new Date().toISOString(), chain: 'robinhood', contract: '0xslug', grade: 'A', remaining: '5', projected: '5', start: nowSec - 3600, slug: 'stock-salesman' },
  ];
  const rows = loadDashboardRows(slugState, slugHistory, { version: 1, entries: {} }, () => null, []);
  assert.equal(rows[0].links.opensea, 'https://opensea.io/collection/stock-salesman');
  const html = renderDashboard(rows, { generatedAt: 'now', sources: [] });
  assert.ok(html.includes('https://opensea.io/collection/stock-salesman'));
});
