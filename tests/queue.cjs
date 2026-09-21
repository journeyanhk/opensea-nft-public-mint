const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  enqueueJob, claimNext, completeJob, failJob, cancelJob, reclaimStale, listJobs,
  createArmToken, publishArmToken, setArmed, isArmed, clearArmed, validateJobInput, loadOrCreateArmToken,
} = require('../dist/executor/queue');

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'queue-'));
const W = '0x65f001aa4109bb8d3bf70af66855aba1e5582625';
const input = (extra = {}) => ({
  chain: 'robinhood',
  contract: W,
  slug: 'cool',
  name: 'Cool',
  quantity: 1,
  maxPriceEth: 'current',
  startAtMs: Date.now() + 60_000,
  ...extra,
});

test('enqueue validates the job and writes it to the queue directory', () => {
  const q = dir();
  assert.equal(validateJobInput(input()).ok, true);
  assert.equal(validateJobInput(input({ contract: '0xabc' })).ok, false);
  assert.equal(validateJobInput(input({ quantity: 99 })).ok, false);
  assert.equal(validateJobInput(input({ chain: '' })).ok, false);

  const created = enqueueJob(q, input(), 1_000);
  assert.equal(created.ok, true);
  assert.equal(created.job.status, 'queued');
  assert.equal(created.job.attempts, 0);
  assert.ok(fs.existsSync(path.join(q, `${created.job.id}.json`)));

  const rejected = enqueueJob(q, input({ contract: 'nope' }), 1_000);
  assert.equal(rejected.ok, false);
  assert.match(rejected.reason, /address/);
});

test('claimNext takes the oldest eligible job atomically and leaves far-future ones alone', () => {
  const q = dir();
  const soon = enqueueJob(q, input({ startAtMs: 5_000 }), 1_000).job;
  const later = enqueueJob(q, input({ contract: W, slug: 'later', startAtMs: 10 * 3_600_000 }), 2_000).job;
  const far = enqueueJob(q, input({ contract: W, slug: 'far', startAtMs: 99 * 3_600_000 }), 3_000).job;

  const claim = claimNext(q, { by: 'host', nowMs: 4_000, leaseMs: 60_000, claimWindowMs: 2 * 3_600_000 });
  assert.equal(claim.ok, true);
  assert.equal(claim.job.id, soon.id);
  assert.equal(claim.job.status, 'claimed');
  assert.equal(claim.job.attempts, 1);
  assert.equal(fs.existsSync(path.join(q, `${soon.id}.json`)), false, 'the queued file moved');
  assert.ok(fs.existsSync(path.join(q, 'claimed', `${soon.id}.json`)));

  // The far job is still not claimable even after the nearer one is taken.
  const none = claimNext(q, { by: 'host', nowMs: 4_000, leaseMs: 60_000, claimWindowMs: 2 * 3_600_000 });
  assert.equal(none.ok, false);
  assert.equal(none.reason, 'no eligible job');
  assert.ok(fs.existsSync(path.join(q, `${far.id}.json`)));
  assert.ok(fs.existsSync(path.join(q, `${later.id}.json`)));
});

test('a stale lease is reclaimed, capped by attempts', () => {
  const q = dir();
  const job = enqueueJob(q, input({ startAtMs: 1_000 }), 1_000).job;
  claimNext(q, { by: 'host', nowMs: 2_000, leaseMs: 1_000, claimWindowMs: 60_000 });

  assert.deepEqual(reclaimStale(q, { nowMs: 5_000, maxAttempts: 2 }), [job.id]);
  assert.ok(fs.existsSync(path.join(q, `${job.id}.json`)), 'back in the queue');
  assert.equal(fs.existsSync(path.join(q, 'claimed', `${job.id}.json`)), false);

  const second = claimNext(q, { by: 'host', nowMs: 6_000, leaseMs: 1_000, claimWindowMs: 60_000 });
  assert.equal(second.job.attempts, 2);
  reclaimStale(q, { nowMs: 9_000, maxAttempts: 2 });
  const exhausted = claimNext(q, { by: 'host', nowMs: 10_000, leaseMs: 1_000, claimWindowMs: 60_000 });
  assert.equal(exhausted.ok, false, 'a job that burned its attempts is not queued again');
});

test('complete moves the job to done with the ledger-derived result', () => {
  const q = dir();
  const job = enqueueJob(q, input({ startAtMs: 1_000 }), 1_000).job;
  const claimed = claimNext(q, { by: 'host', nowMs: 2_000, leaseMs: 60_000, claimWindowMs: 60_000 }).job;
  completeJob(q, claimed, { status: 'SUCCESS', txHash: '0xdead', mintedCount: 1, tokenIds: ['7'], gasBurnedWei: '1', ledgerStatus: 'SUCCESS' }, 3_000);
  assert.ok(fs.existsSync(path.join(q, 'done', `${job.id}.json`)));
  const view = listJobs(q, 4_000);
  assert.equal(view[0].status, 'done');
  assert.equal(view[0].result.mintedCount, 1);
});

test('cancel works on a queued job and on a claimed-but-unsigned one', () => {
  const q = dir();
  const queued = enqueueJob(q, input({ startAtMs: 1_000 }), 1_000).job;
  assert.equal(cancelJob(q, queued.id, 2_000).ok, true);
  assert.equal(listJobs(q, 3_000).find((job) => job.id === queued.id).status, 'cancelled');

  const claimed = enqueueJob(q, input({ startAtMs: 1_000 }), 4_000).job;
  claimNext(q, { by: 'host', nowMs: 5_000, leaseMs: 60_000, claimWindowMs: 60_000 });
  const cancel = cancelJob(q, claimed.id, 6_000);
  assert.equal(cancel.ok, true);
  assert.equal(cancel.flagged, true, 'the executor must see the cancel flag');
  const stored = JSON.parse(fs.readFileSync(path.join(q, 'claimed', `${claimed.id}.json`), 'utf8'));
  assert.equal(stored.cancelRequested, true);
});

test('arming needs the executor token and expires', () => {
  const q = dir();
  const token = createArmToken();
  publishArmToken(q, token); // what the executor does at startup (hash only on disk)
  assert.equal(isArmed(q, 1_000).armed, false, 'publishing the token does not arm anything');
  assert.equal(setArmed(q, { token: 'wrong', nowMs: 1_000, ttlMs: 60_000 }).ok, false);
  assert.equal(setArmed(q, { token, nowMs: 1_000, ttlMs: 60_000 }).ok, true);
  assert.equal(isArmed(q, 2_000).armed, true);
  assert.equal(isArmed(q, 61_000).armed, false, 'the arm expires');
  assert.equal(clearArmed(q).ok, true);
  assert.equal(isArmed(q, 62_000).armed, false);
});

test('infrastructure files in the queue directory are never treated as jobs', () => {
  const q = dir();
  const job = enqueueJob(q, input({ startAtMs: 1_000 }), 1_000).job;
  const token = createArmToken();
  publishArmToken(q, token);
  fs.writeFileSync(path.join(q, '_heartbeat.json'), JSON.stringify({ at: 't', host: 'h', pid: 1 }));
  fs.writeFileSync(path.join(q, 'ARMED.json'), JSON.stringify({ expiresAtMs: 0 }));
  fs.writeFileSync(path.join(q, 'garbage.json'), JSON.stringify({ hello: 'world' }));
  fs.writeFileSync(path.join(q, 'broken.json'), 'not json');

  const view = listJobs(q, 2_000);
  assert.equal(view.length, 1, 'only the real job is listed');
  assert.equal(view[0].id, job.id);
  const claim = claimNext(q, { by: 'host', nowMs: 2_000, leaseMs: 1_000, claimWindowMs: 60_000 });
  assert.equal(claim.ok, true, 'claiming still works with neighbours present');
});

test('the soonest opening is claimed first, whatever the enqueue order', () => {
  const q = dir();
  const late = enqueueJob(q, input({ startAtMs: 90 * 60_000 }), 1_000).job;   // enqueued first, opens later
  const soon = enqueueJob(q, input({ startAtMs: 10 * 60_000 }), 2_000).job;  // enqueued later, opens sooner
  const claim = claimNext(q, { by: 'host', nowMs: 3_000, leaseMs: 60_000, claimWindowMs: 2 * 3_600_000 });
  assert.equal(claim.job.id, soon.id, 'a nearer opening must not miss its window');
  assert.notEqual(claim.job.id, late.id);
});

test('the arm token is stable across restarts and keeps a live arm window', () => {
  const q = dir();
  const first = loadOrCreateArmToken(q);
  assert.equal(first.created, true);
  assert.equal(fs.statSync(path.join(q, 'arm-token')).mode & 0o777, 0o600, 'readable only by the owner');
  const again = loadOrCreateArmToken(q);
  assert.equal(again.created, false);
  assert.equal(again.token, first.token, 'a restart reuses the token');

  // The executor publishes the hash at startup; the first publish starts disarmed.
  assert.equal(publishArmToken(q, first.token).keptArm, false);
  setArmed(q, { token: first.token, nowMs: 1_000, ttlMs: 60_000 });
  assert.equal(publishArmToken(q, first.token).keptArm, true);
  assert.equal(isArmed(q, 30_000).armed, true, 'the arm window survives a restart');
  assert.equal(isArmed(q, 61_000).armed, false, 'but it still expires');

  // Rotating invalidates the old token and disarms.
  const rotated = loadOrCreateArmToken(q, { rotate: true });
  assert.notEqual(rotated.token, first.token);
  assert.equal(publishArmToken(q, rotated.token).keptArm, false);
  assert.equal(setArmed(q, { token: first.token, nowMs: 62_000, ttlMs: 60_000 }).ok, false, 'the old token no longer arms');
  assert.equal(setArmed(q, { token: rotated.token, nowMs: 62_000, ttlMs: 60_000 }).ok, true);
});
