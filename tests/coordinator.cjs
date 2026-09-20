const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { LaneCoordinator, planReservation, orderJobs } = require('../dist/batch-coordinator');
const { acquireWalletLock } = require('../dist/wallet-lock');

const W1 = '0x65f001aa4109bb8d3bf70af66855aba1e5582625';
const W2 = '0xf43bc9019c620c7eb82b43ada900cb7f535c58c2';

test('planReservation covers gas for every shot and value only when overshoot can land', () => {
  const base = { value: 1_000n, gasLimit: 250_000n, maxFeePerGas: 2_000_000_000n };
  assert.equal(planReservation({ ...base, shots: 1 }), 1_000n + 250_000n * 2_000_000_000n);
  // Free drop, burst: only gas multiplies.
  assert.equal(
    planReservation({ value: 0n, gasLimit: 250_000n, maxFeePerGas: 2_000_000_000n, shots: 4 }),
    4n * 250_000n * 2_000_000_000n
  );
  // Paid drop with overshoot: up to four shots can land, each paying value.
  assert.equal(
    planReservation({ ...base, shots: 4, overshoot: true }),
    4n * 1_000n + 4n * 250_000n * 2_000_000_000n
  );
  assert.equal(planReservation({ ...base, shots: 4 }), 1_000n + 4n * 250_000n * 2_000_000_000n);
});

test('a lane is exclusive until released, and a crashed lease expires', () => {
  const coordinator = new LaneCoordinator();
  const first = coordinator.acquire({ jobId: 'job-a', wallet: W1, nowMs: 1_000, leaseMs: 60_000 });
  assert.equal(first.ok, true);
  const second = coordinator.acquire({ jobId: 'job-b', wallet: W1, nowMs: 1_001 });
  assert.equal(second.ok, false);
  assert.match(second.reason, /job-a/);

  // A different wallet is a different lane: parallel is the point.
  assert.equal(coordinator.acquire({ jobId: 'job-b', wallet: W2, nowMs: 1_001 }).ok, true);

  // Only the owner can release; an expired lease frees the lane by itself.
  assert.equal(coordinator.release(W1, 'job-b'), false);
  assert.equal(coordinator.release(W1, 'job-a'), true);
  assert.equal(coordinator.acquire({ jobId: 'job-b', wallet: W1, nowMs: 2_000 }).ok, true);

  const expired = coordinator.expire(70_000);
  assert.ok(expired.includes(W1));
  assert.equal(coordinator.acquire({ jobId: 'job-c', wallet: W1, nowMs: 70_001 }).ok, true);
  coordinator.reserve({ jobId: 'job-c', wallet: W1, wei: 5n });
  assert.equal(coordinator.snapshot().find((lane) => lane.wallet === W1).reservedWei, 5n);
});

test('a lease must be renewed or it is treated as a crash', () => {
  const coordinator = new LaneCoordinator();
  coordinator.acquire({ jobId: 'job-a', wallet: W1, nowMs: 0, leaseMs: 1_000 });
  // The holder keeps proving it is alive: an expire inside the renewed window
  // must not hand the wallet to somebody else.
  assert.equal(coordinator.renew({ wallet: W1, jobId: 'job-a', nowMs: 900, leaseMs: 1_000 }), true);
  assert.deepEqual(coordinator.expire(1_500), []);
  assert.equal(coordinator.acquire({ jobId: 'job-b', wallet: W1, nowMs: 1_500 }).ok, false);
  // Nobody renewed past 1_900: recovery, not preemption.
  assert.deepEqual(coordinator.expire(2_000), [W1]);
  assert.equal(coordinator.acquire({ jobId: 'job-b', wallet: W1, nowMs: 2_000 }).ok, true);
  // Only the holder may renew.
  assert.equal(coordinator.renew({ wallet: W1, jobId: 'job-a', nowMs: 2_100 }), false);
});

test('reservations accumulate per job instead of overwriting the lane', () => {
  const coordinator = new LaneCoordinator();
  assert.deepEqual(coordinator.reserve({ jobId: 'job-a', wallet: W1, wei: 100n }), { ok: true });
  assert.deepEqual(coordinator.reserve({ jobId: 'job-b', wallet: W1, wei: 50n }), { ok: true });
  assert.equal(coordinator.reservedTotal(W1), 150n);
  assert.deepEqual(coordinator.reservedBy(W1), { 'job-a': 100n, 'job-b': 50n });

  // A third target merged by --watch is rejected against a limit, with the gap.
  const rejected = coordinator.reserve({ jobId: 'job-c', wallet: W1, wei: 900n, limitWei: 1_000n });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.shortfallWei, 50n);

  // Releasing the send lane does not release the money.
  coordinator.acquire({ jobId: 'job-a', wallet: W1, nowMs: 0 });
  assert.equal(coordinator.release(W1, 'job-a'), true);
  assert.equal(coordinator.reservedTotal(W1), 150n);
  assert.equal(coordinator.unreserve({ jobId: 'job-a', wallet: W1 }), 100n);
  assert.equal(coordinator.reservedTotal(W1), 50n);
  // Reserving twice for the same job replaces its own claim, never adds to it.
  coordinator.reserve({ jobId: 'job-b', wallet: W1, wei: 80n });
  assert.equal(coordinator.reservedTotal(W1), 80n);
});

test('orderJobs sorts by start, maps the conflicts and breaks ties by priority', () => {
  const jobs = [
    { id: 'late', wallets: [W1], startMs: 20_000, priority: 0 },
    { id: 'early', wallets: [W2], startMs: 10_000, priority: 0 },
    { id: 'clash', wallets: [W1], startMs: 12_000, priority: 5 },
    { id: 'near', wallets: [W1], startMs: 13_000, priority: 0 },
  ];
  const { order, conflicts } = orderJobs(jobs);
  assert.deepEqual(order, ['early', 'clash', 'near', 'late'], 'soonest first');
  assert.deepEqual(conflicts, [{ wallet: W1, jobs: ['clash', 'near'] }], 'same wallet within 5s');

  const tie = orderJobs([
    { id: 'low', wallets: [W1], startMs: 5_000, priority: 0 },
    { id: 'high', wallets: [W1], startMs: 5_000, priority: 9 },
  ]);
  assert.equal(tie.order[0], 'high', 'priority breaks a same-start tie');
  assert.deepEqual(tie.conflicts, [{ wallet: W1, jobs: ['high', 'low'] }]);
});

test('the wallet lock is exclusive across processes and recovers a dead holder', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-lock-'));
  const first = await acquireWalletLock(W1, dir);
  await assert.rejects(() => acquireWalletLock(W1, dir), /already|in use|locked/i);

  await first.release();
  const again = await acquireWalletLock(W1, dir);
  await again.release();

  // A lock file whose pid is gone is stale, not fatal.
  const lockFile = path.join(dir, `${W2}.lock`);
  fs.writeFileSync(lockFile, JSON.stringify({ version: 2, pid: 999_999_999, token: 'dead', startedUtc: 'x' }));
  const recovered = await acquireWalletLock(W2, dir);
  assert.equal(recovered.recovered, true);
  await recovered.release();
  assert.equal(fs.existsSync(lockFile), false, 'release removes the file');
});

test('the wallet mutex survives an unrelated port occupant and reports a live holder', async () => {
  const net = require('node:net');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-port-'));
  // An unrelated service sits on the port this wallet would hash to.
  const squatter = net.createServer((socket) => socket.destroy());
  await new Promise((resolve) => squatter.listen({ host: '127.0.0.1', port: 0 }, resolve));
  const taken = squatter.address().port;
  try {
    const lock = await acquireWalletLock(W1, dir, { port: taken });
    assert.equal(lock.port, taken + 1, 'it steps over an unrelated occupant');
    assert.equal(fs.existsSync(path.join(dir, W1 + '.lock')), true);
    await lock.release();

    // A live holder (our own pid) is reported instead of being stolen.
    fs.writeFileSync(
      path.join(dir, W1 + '.lock'),
      JSON.stringify({ version: 2, pid: process.pid, token: 'held', port: taken + 20 })
    );
    await assert.rejects(() => acquireWalletLock(W1, dir, { port: taken + 20 }), /locked by pid/);
  } finally {
    await new Promise((resolve) => squatter.close(resolve));
  }
});
