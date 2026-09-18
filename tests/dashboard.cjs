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
