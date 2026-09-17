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
const { isCandidateDrop, shouldAudit, discoveryTopics, CONFIRMATIONS } = require('../dist/scan/scanner');
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

test('discovery watches both config changes and mints, with a confirmation lag', () => {
  assert.deepEqual(discoveryTopics(), [PUBLIC_DROP_UPDATED_TOPIC, SEADROP_MINT_TOPIC]);
  assert.ok(CONFIRMATIONS >= 32);
});
