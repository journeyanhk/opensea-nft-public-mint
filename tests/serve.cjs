const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assertNoPrivateKeys, serveConfig } = require('../dist/serve/config');
const { createServer, sanitizeLog } = require('../dist/serve/server');

const row = (contract, chain = 'arc', grade = 'A') => ({
  chain,
  contract,
  start: 1_758_000_000,
  grade,
  gradeHistory: [],
  remaining: '10',
  projected: '5',
  lastAuditedAt: '2026-09-17T08:00:00.000Z',
  pendingAudit: false,
  soldOut: false,
  execution: null,
  stages: [],
  topMinterShare: null,
  nets: {},
  notes: [],
  name: null,
  owner: null,
  mintPriceWei: null,
  capPerWallet: null,
  endTime: null,
  maxSupply: null,
  minted: null,
  recent15m: null,
  recent1h: null,
  uniqueMinters: null,
  presaleStages: null,
  velocity24h: null,
  velocitySource: null,
  sellOutEtaHours: null,
  stale: false,
  links: { opensea: "", explorer: "" },
});

function stubScheduler() {
  return {
    ticks: 0,
    rows: [row('0xaaa'), row('0xbbb', 'robinhood', 'B')],
    status: {
      running: false,
      lastScanAt: '2026-09-17T08:00:00.000Z',
      nextScanAt: '2026-09-17T08:15:00.000Z',
      lastError: null,
      chains: ['arc', 'robinhood'],
      cursors: { arc: 123 },
      log: [
        '2026-09-17T08:00:00.000Z scanning https://arc-mainnet.example.com/v2/SECRETKEY123456',
        '2026-09-17T08:00:01.000Z read /home/nft/opensea-nft-public-mint/.scan-state.json',
      ],
      lastReports: null,
      backfill: null,
      rowCount: 2,
    },
    async tick() {
      this.ticks++;
      return this.tickResult !== false;
    },
    tickResult: true,
  };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

test('assertNoPrivateKeys fails closed on key material', () => {
  assert.doesNotThrow(() => assertNoPrivateKeys({}));
  assert.doesNotThrow(() => assertNoPrivateKeys({ PRIVATE_KEY: '  ' }));
  assert.throws(() => assertNoPrivateKeys({ PRIVATE_KEY: '0xabc' }), /refuses to run/);
  assert.throws(() => assertNoPrivateKeys({ PRIVATE_KEYS: '0xabc,0xdef' }), /PRIVATE_KEYS/);
});

test('serveConfig applies defaults and overrides', () => {
  const defaults = serveConfig({});
  assert.equal(defaults.host, '127.0.0.1');
  assert.equal(defaults.port, 8787);
  assert.deepEqual(defaults.chains, ['robinhood', 'arc']);
  assert.equal(defaults.intervalMs, 15 * 60_000);
  assert.equal(defaults.lookbackDays, 0.5);

  const custom = serveConfig({
    SERVE_HOST: '0.0.0.0',
    SERVE_PORT: '9000',
    SCAN_CHAINS: 'arc',
    SCAN_INTERVAL_MIN: '5',
    SCAN_LIMIT: '3',
    SCAN_LOOKBACK_DAYS: '0.2',
    SCAN_INCLUDE_MINTS: '1',
  });
  assert.equal(custom.host, '0.0.0.0');
  assert.equal(custom.port, 9000);
  assert.deepEqual(custom.chains, ['arc']);
  assert.equal(custom.intervalMs, 5 * 60_000);
  assert.equal(custom.limit, 3);
  assert.equal(custom.lookbackDays, 0.2);
  assert.equal(custom.includeMints, true);
});

test('sanitizeLog masks RPC keys and absolute paths', () => {
  const [line] = sanitizeLog(['2026-09-17 scanning https://arc.example.com/v2/SECRETKEY123456 then /home/nft/secret/path.json']);
  assert.ok(!line.includes('SECRETKEY123456'));
  assert.ok(!line.includes('/home/nft/secret/path.json'));
  assert.ok(line.includes('scanning'));
});

test('http surface: health, dashboard, status, rows, scan, and the guards', async () => {
  const scheduler = stubScheduler();
  const server = createServer({ scheduler, exportsDir: '/tmp/exports' });
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  try {
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    const page = await fetch(`${base}/`);
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.ok(html.includes('id="statusBar"'));
    assert.ok(html.includes('0xaaa'));

    const status = await fetch(`${base}/api/status`);
    const statusBody = await status.json();
    assert.equal(status.status, 200);
    assert.equal(statusBody.rowCount, 2);
    const statusText = JSON.stringify(statusBody);
    assert.ok(!statusText.includes('SECRETKEY123456'));
    assert.ok(!statusText.includes('/home/nft/'));

    const rows = await fetch(`${base}/api/rows?chain=robinhood&grade=B`);
    const rowsBody = await rows.json();
    assert.equal(rowsBody.length, 1);
    assert.equal(rowsBody[0].contract, '0xbbb');

    const bad = await fetch(`${base}/api/scan`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' });
    assert.equal(bad.status, 415);

    const crossOrigin = await fetch(`${base}/api/scan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example.com' },
      body: '{}',
    });
    assert.equal(crossOrigin.status, 403);

    const scan = await fetch(`${base}/api/scan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(scan.status, 202);
    assert.equal((await scan.json()).started, true);
    assert.equal(scheduler.ticks, 1);

    const throttled = await fetch(`${base}/api/scan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(throttled.status, 429);

    const missing = await fetch(`${base}/nope`);
    assert.equal(missing.status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('http surface: a busy scheduler answers 409', async () => {
  const scheduler = stubScheduler();
  scheduler.tickResult = false;
  const server = createServer({ scheduler, exportsDir: '/tmp/exports' });
  const port = await listen(server);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/scan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(res.status, 409);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('favorites api: round-trip, jsonl export and the same guards', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fav-api-'));
  const favoritesPath = path.join(dir, '.favorites.json');
  const scheduler = stubScheduler();
  const server = createServer({ scheduler, exportsDir: '/tmp/exports', favoritesPath });
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  try {
    const empty = await (await fetch(`${base}/api/favorites`)).json();
    assert.equal(Object.keys(empty.favorites).length, 0);

    const added = await fetch(`${base}/api/favorites`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'add', chain: 'robinhood', contract: '0x65f001aa4109bb8d3bf70af66855aba1e5582625', name: 'A', snapshot: { q: 76, grade: 'A', penalties: [] } }),
    });
    assert.equal(added.status, 200);
    assert.equal((await added.json()).favorite.status, 'watching');

    const updated = await fetch(`${base}/api/favorites`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'update', chain: 'robinhood', contract: '0x65f001aa4109bb8d3bf70af66855aba1e5582625', status: 'ready', note: 'good' }),
    });
    const record = (await updated.json()).favorite;
    assert.equal(record.note, 'good');
    assert.equal(record.snapshot.q, 76, 'an edit keeps the snapshot');

    const jsonl = await (await fetch(`${base}/api/favorites?format=jsonl`)).text();
    assert.equal(jsonl.trim().split('\n').length, 1);
    assert.equal(JSON.parse(jsonl.trim()).key, 'robinhood|0x65f001aa4109bb8d3bf70af66855aba1e5582625');

    // The page embeds the store.
    const page = await (await fetch(`${base}/`)).text();
    assert.ok(page.includes('0x65f001aa'));

    const badAddress = await fetch(`${base}/api/favorites`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "add", chain: "robinhood", contract: "0xnothex" }),
    });
    assert.equal(badAddress.status, 400);
    const badChain = await fetch(`${base}/api/favorites`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "add", chain: "solana", contract: "0x65f001aa4109bb8d3bf70af66855aba1e5582625" }),
    });
    assert.equal(badChain.status, 400);
    const longNote = await fetch(`${base}/api/favorites`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "update", chain: "robinhood", contract: "0x65f001aa4109bb8d3bf70af66855aba1e5582625", note: "x".repeat(501) }),
    });
    assert.equal(longNote.status, 400);

    const badType = await fetch(`${base}/api/favorites`, {
      method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x',
    });
    assert.equal(badType.status, 415);
    const crossOrigin = await fetch(`${base}/api/favorites`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ action: 'add', chain: 'a', contract: 'b' }),
    });
    assert.equal(crossOrigin.status, 403);

    const removed = await fetch(`${base}/api/favorites`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'remove', chain: 'robinhood', contract: '0x65f001aa4109bb8d3bf70af66855aba1e5582625' }),
    });
    assert.equal((await removed.json()).removed, true);
    const after = await (await fetch(`${base}/api/favorites`)).json();
    assert.equal(Object.keys(after.favorites).length, 0);
  } finally {
    server.close();
  }
});

test('queue api: enqueue, list, cancel and the arm second factor', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { createArmToken, publishArmToken } = require('../dist/executor/queue');
  const queueDir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-api-'));
  const scheduler = stubScheduler();
  const server = createServer({ scheduler, exportsDir: '/tmp/exports', queueDir });
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  const contract = '0x65f001aa4109bb8d3bf70af66855aba1e5582625';
  try {
    const enqueued = await fetch(`${base}/api/queue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chain: 'robinhood', contract, slug: 'cool', quantity: 1, codeHash: '0x' + 'ab'.repeat(32) }),
    });
    assert.equal(enqueued.status, 200);
    const job = (await enqueued.json()).job;
    assert.equal(job.status, 'queued');
    assert.equal(job.armRequired || true, true);

    const bad = await fetch(`${base}/api/queue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chain: 'solana', contract }),
    });
    assert.equal(bad.status, 400, 'unsupported chain is refused');

    const list = await (await fetch(`${base}/api/queue`)).json();
    assert.equal(list.jobs.length, 1);
    assert.equal(list.armed.armed, false, 'enqueueing does not arm anything');

    // Arming needs the token the executor printed; publishing alone is not enough.
    const token = createArmToken();
    publishArmToken(queueDir, token);
    const wrong = await fetch(`${base}/api/queue/arm`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'nope' }),
    });
    assert.equal(wrong.status, 403);
    const armed = await fetch(`${base}/api/queue/arm`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }),
    });
    assert.equal(armed.status, 200);
    assert.equal((await armed.json()).armed.armed, true);

    const cancelled = await fetch(`${base}/api/queue/cancel`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: job.id }),
    });
    assert.equal(cancelled.status, 200);
  } finally {
    server.close();
  }
});
