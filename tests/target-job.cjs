const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createJobs, advance, jobsToPrepare, TERMINAL_STATES } = require('../dist/target-job');

const W1 = '0x65f001aa4109bb8d3bf70af66855aba1e5582625';
const target = (id, startMs, wallets = [W1]) => ({ id, contract: id, startMs, wallets, priority: 0 });

test('jobs start waiting and only legal transitions advance them', () => {
  const [job] = createJobs([target('a', 10_000)], 0);
  assert.equal(job.state, 'waiting');
  assert.equal(advance(job, 'prepare'), true);
  assert.equal(job.state, 'preparing');
  assert.equal(advance(job, 'lane'), true);
  assert.equal(job.state, 'sending');
  assert.equal(advance(job, 'receipt'), true);
  assert.equal(job.state, 'receipt');
  assert.equal(advance(job, 'done'), true);
  assert.equal(job.state, 'done');
  assert.ok(TERMINAL_STATES.includes('done'));

  // Illegal moves are refused, not applied.
  assert.equal(advance(job, 'prepare'), false);
  assert.equal(job.state, 'done');

  const waiting = createJobs([target('b', 10_000)], 0)[0];
  assert.equal(advance(waiting, 'done'), false, 'cannot finish before starting');
  assert.equal(advance(waiting, 'fail'), true);
  assert.equal(waiting.state, 'failed');
});

test('jobsToPrepare respects the prepare window and the order', () => {
  const jobs = createJobs([target('late', 600_000), target('soon', 300_000), target('done', 100_000)], 0);
  assert.equal(advance(jobs.find((job) => job.id === 'done'), 'fail'), true, 'already terminal');

  // With a 10 minute prepare window, both future jobs are eligible.
  assert.deepEqual(jobsToPrepare(jobs, 0, 600_000).map((job) => job.id), ['soon', 'late']);
  // A 400s window reaches the sooner job only (300s in, 600s out).
  assert.deepEqual(jobsToPrepare(jobs, 0, 400_000).map((job) => job.id), ['soon']);
  // Terminal jobs never come back.
  assert.equal(jobsToPrepare(jobs, 400_000, 600_000).some((job) => job.id === 'done'), false);
});

test('createJobs sorts by start time and records the wallet conflict', () => {
  const jobs = createJobs([target('second', 20_000), target('first', 10_000)], 0);
  assert.deepEqual(jobs.map((job) => job.id), ['first', 'second']);
  assert.deepEqual(jobs[0].wallets, [W1]);
});
