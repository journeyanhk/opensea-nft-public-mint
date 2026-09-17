const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  emptyState,
  loadState,
  saveState,
  recordContracts,
  advanceCursor,
} = require('../dist/scan/state');
const { isCandidateDrop, shouldAudit, discoveryTopics, CONFIRMATIONS, selectAuditBatch } = require('../dist/scan/scanner');
const { PUBLIC_DROP_UPDATED_TOPIC, SEADROP_MINT_TOPIC } = require('../dist/audit/events');

const A = '0xaaa0000000000000000000000000000000000001';
const B = '0xbbb0000000000000000000000000000000000002';
const AT = '2026-09-17T08:00:00.000Z';

test('records new contracts once and only moves last-seen for known ones', () => {
  const state = emptyState();
  const added = recordContracts(state, 'arc', [{ contract: A, block: 100 }], AT);
  assert.deepEqual(added, [A]);
  assert.equal(state.contracts.arc[A].firstSeenBlock, 100);
  assert.equal(state.contracts.arc[A].lastAuditedBlock, null);

  const again = recordContracts(state, 'arc', [{ contract: A, block: 250 }, { contract: B, block: 200 }], AT);
  assert.deepEqual(again, [B]);
  assert.equal(state.contracts.arc[A].firstSeenBlock, 100);
  assert.equal(state.contracts.arc[A].lastSeenBlock, 250);
  assert.equal(state.contracts.arc[B].firstSeenBlock, 200);
});

test('advances and persists the cursor atomically', () => {
  const state = emptyState();
  advanceCursor(state, 'robinhood', 500, 0.101, AT);
  assert.deepEqual(state.chains.robinhood, { cursorBlock: 500, blockTimeSec: 0.101, updatedAt: AT });

  const file = path.join(os.tmpdir(), `scan-state-${Date.now()}.json`);
  try {
    saveState(state, file);
    const { state: loaded, corrupt } = loadState(file);
    assert.equal(corrupt, false);
    assert.equal(loaded.chains.robinhood.cursorBlock, 500);
    fs.writeFileSync(file, '{ not json');
    const broken = loadState(file);
    assert.equal(broken.corrupt, true);
    assert.deepEqual(broken.state, emptyState());
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('missing state file is not treated as corruption', () => {
  const { state, corrupt } = loadState(path.join(os.tmpdir(), `missing-${Date.now()}.json`));
  assert.equal(corrupt, false);
  assert.deepEqual(state, emptyState());
});

const drop = (startTime, endTime) => ({ mintPrice: 0n, startTime, endTime, maxTotalMintableByWallet: 1, feeBps: 0, restrictFeeRecipients: false });

test('candidate filter keeps only live or upcoming drops inside the horizon', () => {
  const now = 1_000_000;
  assert.equal(isCandidateDrop(drop(now - 100, now + 100), now, 72), true);
  assert.equal(isCandidateDrop(drop(now + 3600, now + 7200), now, 72), true);
  assert.equal(isCandidateDrop(drop(now - 500, now), now, 72), false);
  assert.equal(isCandidateDrop(drop(now + 72 * 3600, now + 73 * 3600), now, 72), true);
  assert.equal(isCandidateDrop(drop(now + 72 * 3600 + 1, now + 73 * 3600), now, 72), false);
});

const entry = (over = {}) => ({
  firstSeenBlock: 1,
  lastSeenBlock: 10,
  lastAuditedBlock: 10,
  lastAuditedAt: new Date(1_000_000).toISOString(),
  lastGrade: 'A',
  soldOutAtBlock: null,
  publicStart: null,
  ...over,
});

test('re-audit policy: new, changed, approaching, and sold-out contracts', () => {
  const now = 1_000_000;
  const horizon = 72 * 3600_000;
  const base = { nowMs: now, horizonMs: horizon };

  assert.equal(shouldAudit({ ...base, entry: undefined, eventSinceAudit: false, startAtMs: null }), true);

  assert.equal(
    shouldAudit({ ...base, entry: entry(), eventSinceAudit: true, startAtMs: now + 3600_000 }),
    true
  );
  assert.equal(
    shouldAudit({ ...base, entry: entry({ lastAuditedAt: null }), eventSinceAudit: false, startAtMs: now + 3600_000 }),
    true
  );
  assert.equal(
    shouldAudit({ ...base, entry: entry({ soldOutAtBlock: 10 }), eventSinceAudit: false, startAtMs: now + 3600_000 }),
    false
  );
  assert.equal(
    shouldAudit({ ...base, entry: entry({ soldOutAtBlock: 10 }), eventSinceAudit: true, startAtMs: now + 3600_000 }),
    true
  );

  const fresh = entry({ lastAuditedAt: new Date(now - 60_000).toISOString() });
  assert.equal(shouldAudit({ ...base, entry: fresh, eventSinceAudit: false, startAtMs: now + 3600_000 }), false);
  const stale = entry({ lastAuditedAt: new Date(now - 60 * 60_000).toISOString() });
  assert.equal(shouldAudit({ ...base, entry: stale, eventSinceAudit: false, startAtMs: now + 3600_000 }), true);
  assert.equal(shouldAudit({ ...base, entry: stale, eventSinceAudit: false, startAtMs: now + 30 * 24 * 3600_000 }), false);
});

test('discovery watches config changes by default and mints only when asked', () => {
  assert.deepEqual(discoveryTopics(), [PUBLIC_DROP_UPDATED_TOPIC]);
  assert.deepEqual(discoveryTopics(true), [PUBLIC_DROP_UPDATED_TOPIC, SEADROP_MINT_TOPIC]);
  assert.ok(CONFIRMATIONS >= 32);
});

test('a window rejected as too dense is split until it fits', async () => {
  const { scanLogs } = require('../dist/audit/events');
  const realFetch = globalThis.fetch;
  const ranges = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const from = parseInt(body.params[0].fromBlock, 16);
    const to = parseInt(body.params[0].toBlock, 16);
    ranges.push([from, to]);
    if (to - from + 1 > 5000) {
      return { json: async () => ({ error: { message: 'logs matched by query exceeds limit of 10000' } }) };
    }
    return { json: async () => ({ result: [] }) };
  };
  try {
    const logs = await scanLogs('robinhood', '0x0000000000000000000000000000000000000000', [], 0, 9999, {
      rpcUrls: ['http://unused'],
      concurrency: 1,
      maxRetries: 0,
      window: 10000,
    });
    assert.deepEqual(logs, []);
    assert.equal(ranges.length, 3);
    assert.deepEqual(ranges[0], [0, 9999]);
    assert.deepEqual(ranges.slice(1), [[0, 4999], [5000, 9999]]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('adopts the block range the node suggests instead of halving repeatedly', async () => {
  const { scanLogs } = require('../dist/audit/events');
  const realFetch = globalThis.fetch;
  const ranges = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const from = parseInt(body.params[0].fromBlock, 16);
    const to = parseInt(body.params[0].toBlock, 16);
    ranges.push([from, to]);
    if (to - from + 1 > 800) {
      return { json: async () => ({ error: { message: 'query exceeds max results 2000, retry with the range 0-799' } }) };
    }
    return { json: async () => ({ result: [] }) };
  };
  try {
    const logs = await scanLogs('arc', '0x0000000000000000000000000000000000000000', [], 0, 3999, {
      rpcUrls: ['http://unused'],
      concurrency: 1,
      maxRetries: 0,
      window: 10000,
    });
    assert.deepEqual(logs, []);
    assert.deepEqual(ranges[0], [0, 3999]);
    const chunks = ranges.slice(1);
    assert.equal(chunks.length, 5); // 800-block chunks, no halving
    assert.ok(chunks.every(([f, t]) => t - f + 1 === 800));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('switches endpoints when one cannot scan wide ranges', async () => {
  const { scanLogs } = require('../dist/audit/events');
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    if (url === 'http://alchemy') {
      return {
        json: async () => ({
          error: { message: 'Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range' },
        }),
      };
    }
    return { json: async () => ({ result: [] }) };
  };
  try {
    const logs = await scanLogs('robinhood', '0x0000000000000000000000000000000000000000', [], 0, 999, {
      rpcUrls: ['http://alchemy', 'http://public'],
      concurrency: 1,
      maxRetries: 4,
      window: 1000,
    });
    assert.deepEqual(logs, []);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls, ['http://alchemy', 'http://public']);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('range errors are not retried', async () => {
  const { scanLogs } = require('../dist/audit/events');
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return { json: async () => ({ error: { message: 'logs matched by query exceeds limit of 10000' } }) };
  };
  try {
    await assert.rejects(
      scanLogs('robinhood', '0x0000000000000000000000000000000000000000', [], 0, 63, {
        rpcUrls: ['http://unused'],
        concurrency: 1,
        maxRetries: 4,
        window: 64,
      })
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('pending candidates are audited before fresh discoveries', () => {
  assert.deepEqual(selectAuditBatch(['p1', 'p2'], ['f1', 'f2'], 3), { audit: ['p1', 'p2', 'f1'], overflow: ['f2'] });
  assert.deepEqual(selectAuditBatch([], ['f1'], 5), { audit: ['f1'], overflow: [] });
  assert.deepEqual(selectAuditBatch(['p1'], [], 0), { audit: [], overflow: ['p1'] });
});
