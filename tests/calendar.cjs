const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseCalendar, calendarVerdict, upsertCalendar, fetchCalendar } = require('../dist/scan/calendar');
const { loadDashboardRows, renderDashboard, classifyPhase } = require('../dist/scan/html');
const { emptyState, emptyContractEntry } = require('../dist/scan/state');

const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'opensea-calendar.html'), 'utf8');

test('parseCalendar reads the urql_transport dropCalendar payload', () => {
  const entries = parseCalendar(fixture);
  assert.equal(entries.length, 4);
  assert.equal(entries.filter((e) => e.chain === 'robinhood').length, 3);

  const rare = entries.find((e) => e.slug === 'rare-friends-genesis');
  assert.equal(rare.chain, 'robinhood');
  assert.match(rare.address, /^0x[0-9a-f]{40}$/i);
  assert.equal(rare.isVerified, true);
  assert.equal(rare.floorValue, 1900);
  assert.equal(rare.floorSymbol, 'USDG');
  assert.ok(Math.abs(rare.floorUsd - 1899.8081) < 0.01);
  assert.equal(rare.maxSupply, '1024');
  assert.equal(rare.totalSupply, '1024');
  assert.equal(rare.stages.length, 3);
  assert.equal(rare.startTime, Math.floor(Date.parse('2026-09-14T18:00:20.000Z') / 1000));
  // The last stage is the public sale; the first is usually a presale wave, so
  // schedule comparisons must not use it.
  assert.equal(rare.publicStartTime, Math.floor(Date.parse('2026-09-14T19:30:20.000Z') / 1000));

  const eth = entries.find((e) => e.slug === '2o1-patrons');
  assert.equal(eth.chain, 'ethereum');
  assert.equal(eth.isVerified, false);
  assert.equal(eth.floorSymbol, 'ETH');
});

test('parseCalendar fails loud instead of reporting an empty calendar', () => {
  assert.throws(() => parseCalendar('<html><body>no payload</body></html>'), /calendar payload|格式/);
  // urql_transport present but no dropCalendar: also a hard failure.
  assert.throws(() => parseCalendar('<script>window.__urql_transport.push({"data":{}});</script>'), /calendar payload|格式/);
});

test('calendarVerdict canaries a chain that silently went empty and a volume collapse', () => {
  const empty = calendarVerdict({ robinhood: 3, ethereum: 1 }, { robinhood: 0, ethereum: 1 });
  assert.ok(empty.warnings.includes('chain-empty:robinhood'));
  const collapse = calendarVerdict({ robinhood: 100 }, { robinhood: 10 });
  assert.ok(collapse.warnings.includes('volume-drop'));
  assert.deepEqual(calendarVerdict({ robinhood: 2 }, { robinhood: 3 }).warnings, []);
  assert.deepEqual(calendarVerdict(null, { robinhood: 3 }).warnings, []);
});

test('upsertCalendar fills calendar facts without clobbering chain facts', () => {
  const state = emptyState();
  state.contracts.robinhood = {
    '0xabc': {
      ...emptyContractEntry(),
      firstSeenBlock: 7, lastSeenBlock: 9, publicStart: 111, totalMinted: '5', slug: 'onchain-slug', sources: ['onchain'],
    },
  };
  const [entry] = parseCalendar(fixture).filter((e) => e.slug === 'rare-friends-genesis');
  const result = upsertCalendar(state, [{ ...entry, address: '0xAbC' }], '2026-09-19T08:00:00.000Z');

  const kept = state.contracts.robinhood['0xabc'];
  assert.equal(result.updated, 1);
  assert.equal(kept.publicStart, 111, 'chain facts win over the calendar');
  assert.equal(kept.totalMinted, '5');
  assert.equal(kept.slug, 'onchain-slug', 'an existing slug is never overwritten');
  assert.ok(kept.sources.includes('onchain') && kept.sources.includes('opensea-calendar'));
  assert.equal(kept.calendar.listedAt, '2026-09-19T08:00:00.000Z');
  assert.equal(kept.calendar.floorSymbol, 'USDG');

  // A calendar-only entry is created with zero blocks and the page's slug.
  const added = upsertCalendar(state, parseCalendar(fixture), '2026-09-19T08:00:00.000Z');
  assert.ok(added.added >= 3);
  const fresh = state.contracts.robinhood['0xf0474980e09c3023655a9ca3e71a763358214efb'];
  assert.equal(fresh.slug, 'opencatz-by-dizcorvus');
  assert.deepEqual(fresh.sources, ['opensea-calendar']);
  assert.equal(fresh.firstSeenBlock, 0);
  // Without this the entry is in neither candidate seed list (no events, no
  // publicStart yet) and would never be audited.
  assert.equal(fresh.pendingAudit, true, 'a calendar discovery must be queued for audit');
});

test('fetchCalendar sends a browser UA and a timeout', async () => {
  let seen = null;
  const snapshot = await fetchCalendar({
    fetchFn: async (url, init) => {
      seen = { url, ua: init.headers['user-agent'], hasSignal: Boolean(init.signal) };
      return { ok: true, status: 200, text: async () => fixture };
    },
  });
  assert.match(seen.url, /opensea\.io\/drops/);
  assert.match(seen.ua, /Mozilla/);
  assert.equal(seen.hasSignal, true);
  assert.equal(snapshot.entries.length, 4);
  assert.ok(snapshot.fetchedAt);
});

test('a calendar-only target is upcoming, not unaudited, and renders its calendar facts', () => {
  const now = Math.floor(Date.now() / 1000);
  const start = now + 3600;
  const state = emptyState();
  state.contracts.robinhood = {
    '0xf0474980e09c3023655a9ca3e71a763358214efb': {
      ...emptyContractEntry(),
      slug: 'opencatz-by-dizcorvus',
      name: 'OpenCatz',
      sources: ['opensea-calendar'],
      calendar: {
        listedAt: '2026-09-19T08:00:00.000Z',
        startTime: start,
        endTime: start + 3600,
        floorUsd: 11.04,
        floorValue: 0.00419,
        floorSymbol: 'ETH',
        topOfferValue: 0.0037,
        volume24hUsd: null,
        volume24hValue: null,
        isVerified: false,
        disabledReason: null,
        maxSupply: '5000',
        totalSupply: '5000',
        publicStartTime: start,
        stages: [{ startTime: start, endTime: null }],
      },
    },
  };
  const rows = loadDashboardRows(state, [], { version: 1, entries: {} }, () => null);
  assert.equal(rows[0].phase, 'upcoming');
  assert.equal(rows[0].start, start);

  const html = renderDashboard(rows, { generatedAt: 'now', sources: [] });
  assert.ok(html.includes('日历'), 'calendar badge');
  assert.ok(html.includes('未认证'), 'unverified warning');
  assert.ok(html.includes('地板'), 'floor in the detail row');

  // A start time that disagrees with the page is a reschedule signal.
  const mismatch = loadDashboardRows(
    { ...state, contracts: { robinhood: { '0xf0474980e09c3023655a9ca3e71a763358214efb': { ...state.contracts.robinhood['0xf0474980e09c3023655a9ca3e71a763358214efb'], publicStart: start + 7200 } } } },
    [], { version: 1, entries: {} }, () => null
  );
  const mismatchHtml = renderDashboard(mismatch, { generatedAt: 'now', sources: [] });
  assert.ok(mismatchHtml.includes('schedule mismatch'));
});

test('a future calendar start keeps missing facts unknown rather than unaudited', () => {
  const now = 1_000_000;
  assert.equal(
    classifyPhase({ startSec: now + 3600, endSec: null, nowSec: now, minted: null, maxSupply: null, stale: false, soldOut: false }),
    'upcoming'
  );
  // The M5a guarantee is untouched: missing facts are never healthy.
  assert.equal(
    classifyPhase({ startSec: now - 3600, endSec: null, nowSec: now, minted: null, maxSupply: null, stale: false, soldOut: false }),
    'unaudited'
  );
});

test('refreshCalendar only keeps the chains this scan is configured for', async () => {
  const { refreshCalendar } = require('../dist/scan/scanner');
  const now = new Date('2026-09-19T08:00:00.000Z');
  const entries = parseCalendar(fixture);
  const state = emptyState();
  const update = await refreshCalendar(state, {
    now: () => now,
    chains: ['robinhood'],
    calendarFn: async () => ({ fetchedAt: now.toISOString(), entries }),
  });
  assert.deepEqual(update.counts, { robinhood: 3 });
  assert.equal(Object.keys(state.contracts.ethereum ?? {}).length, 0, 'ethereum entries must not land in the state');

  // A chain we do not scan must not trip the canary either.
  const scoped = emptyState();
  scoped.calendar = { fetchedAt: '2026-09-19T07:00:00.000Z', counts: { robinhood: 3, ethereum: 1 } };
  const second = await refreshCalendar(scoped, {
    now: () => now,
    chains: ['robinhood'],
    calendarFn: async () => ({ fetchedAt: now.toISOString(), entries: entries.filter((e) => e.chain === 'robinhood') }),
  });
  assert.deepEqual(second.warnings, []);
});

test('refreshCalendar throttles, applies the snapshot and canaries failures', async () => {
  const { refreshCalendar } = require('../dist/scan/scanner');
  const now = new Date('2026-09-19T08:00:00.000Z');
  const snapshot = { fetchedAt: now.toISOString(), entries: parseCalendar(fixture) };

  // Throttled: a fresh timestamp means the page is not fetched again.
  const fresh = emptyState();
  fresh.calendar = { fetchedAt: now.toISOString(), counts: { robinhood: 3 } };
  let calls = 0;
  const skipped = await refreshCalendar(fresh, {
    now: () => now,
    calendarFn: async () => { calls++; return snapshot; },
  });
  assert.equal(skipped, null);
  assert.equal(calls, 0);

  // Applied: entries land in the state and the counts become the next baseline.
  const stale = emptyState();
  stale.calendar = { fetchedAt: '2026-09-19T07:00:00.000Z', counts: { robinhood: 3, ethereum: 1 } };
  const update = await refreshCalendar(stale, { now: () => now, calendarFn: async () => snapshot });
  assert.equal(update.updated, 0);
  assert.equal(update.added, 4);
  assert.deepEqual(update.counts, { ethereum: 1, robinhood: 3 });
  assert.deepEqual(update.warnings, []);
  assert.ok(stale.contracts.robinhood['0xf0474980e09c3023655a9ca3e71a763358214efb']);
  assert.equal(stale.calendar.fetchedAt, now.toISOString());

  // A chain that went empty raises the canary; a failure keeps the old data.
  const canary = emptyState();
  canary.calendar = { fetchedAt: '2026-09-19T07:00:00.000Z', counts: { robinhood: 3 } };
  const partial = await refreshCalendar(canary, {
    now: () => now,
    calendarFn: async () => ({ fetchedAt: now.toISOString(), entries: [parseCalendar(fixture)[0]] }),
  });
  assert.ok(partial.warnings.includes('chain-empty:robinhood'));
  assert.deepEqual(canary.calendar.warnings, ['chain-empty:robinhood'], 'warnings are persisted for /api/status');

  const failing = emptyState();
  failing.calendar = { fetchedAt: '2026-09-19T07:00:00.000Z', counts: { robinhood: 3 } };
  const messages = [];
  const failed = await refreshCalendar(failing, {
    now: () => now,
    calendarFn: async () => { throw new Error('blocked'); },
    onProgress: (m) => messages.push(m),
  });
  assert.equal(failed, null);
  assert.equal(failing.calendar.fetchedAt, '2026-09-19T07:00:00.000Z', 'previous data survives a failed fetch');
  assert.ok(messages.some((m) => m.includes('calendar unavailable')));
});
