const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { RateLimiter, limitedFetch } = require('../dist/scan/refresh');
const { saveStateMerged } = require('../dist/scan/state');

test('RateLimiter spaces requests to the configured rate', async () => {
  let now = 0;
  const slept = [];
  const limiter = new RateLimiter(2, { now: () => now, sleep: async (ms) => { slept.push(ms); now += ms; } });
  await limiter.acquire(); // first call is free
  await limiter.acquire();
  await limiter.acquire();
  assert.deepEqual(slept, [500, 500]);
});

test('limitedFetch retries once on 429 honouring retry-after, then gives up marked', async () => {
  const slept = [];
  const responses = [
    { ok: false, status: 429, headers: { get: (key) => (key === 'retry-after' ? '7' : null) } },
    { ok: true, status: 200, headers: { get: () => null } },
  ];
  let calls = 0;
  const retried = await limitedFetch('https://api.opensea.io/x', {}, {
    fetchFn: async () => responses[calls++],
    sleep: async (ms) => slept.push(ms),
    limiter: { acquire: async () => {} },
  });
  assert.equal(retried.response.status, 200);
  assert.equal(retried.rateLimited, false);
  assert.deepEqual(slept, [7000]);

  const always = await limitedFetch('https://api.opensea.io/x', {}, {
    fetchFn: async () => ({ ok: false, status: 429, headers: { get: () => null } }),
    sleep: async () => {},
    limiter: { acquire: async () => {} },
  });
  assert.equal(always.response, null);
  assert.equal(always.rateLimited, true);
});

test('saveStateMerged keeps contracts and fields another writer added', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-merge-'));
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      chains: { arc: { cursorBlock: 999, blockTimeSec: 1, updatedAt: 't' } },
      contracts: {
        arc: {
          '0xnew': { firstSeenBlock: 5, lastSeenBlock: 5, lastAuditedBlock: null, lastAuditedAt: null, lastGrade: null, soldOutAtBlock: null, publicStart: null, pendingAudit: false },
        },
      },
    })
  );

  saveStateMerged({ contracts: { arc: { '0xold': { slug: 's', owner: '0xOwner' } } } }, file);

  const merged = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(merged.contracts.arc['0xnew'], 'a concurrently discovered contract survives');
  assert.equal(merged.chains.arc.cursorBlock, 999, 'the scan cursor is not clobbered by a refresh');
  assert.equal(merged.contracts.arc['0xold'].slug, 's');
  assert.equal(merged.contracts.arc['0xold'].owner, '0xOwner');
  assert.equal(merged.contracts.arc['0xnew'].lastSeenBlock, 5, 'untouched fields are preserved');
});

test('the sequencer is sent first and every endpoint keeps its own response', () => {
  const { orderEndpoints } = require('../dist/rpc-blast');
  const endpoints = [
    { url: 'https://alchemy.example', label: 'ALCHEMY' },
    { url: 'https://sequencer.mainnet.chain.robinhood.com', label: 'robinhood-sequencer' },
    { url: 'https://rpc.mainnet.chain.robinhood.com', label: 'robinhood-public' },
  ];
  const ordered = orderEndpoints(endpoints);
  assert.deepEqual(ordered.map((e) => e.label), ['robinhood-sequencer', 'ALCHEMY', 'robinhood-public']);
  assert.equal(endpoints[0].label, 'ALCHEMY', 'the input array is not mutated');
});

test('keepWarm pings now and on an interval until stopped', async () => {
  const { keepWarm } = require('../dist/connection-warmer');
  let calls = 0;
  const fetchFn = async () => {
    calls++;
    return { ok: true };
  };
  const stop = keepWarm(['https://rpc.example'], { untilMs: Date.now() - 1, intervalMs: 1_000, fetchFn });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 1, 'the immediate ping happened');
  stop();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 1, 'nothing pings after stop');
});
