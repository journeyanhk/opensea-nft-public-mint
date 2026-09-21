const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { jobToRawConfig, needsAudit, resultFromLedgerEntry, assertExecutorKeys, resolveMaxPriceEth } = require('../dist/executor/run');
const { enqueueJob, claimNext } = require('../dist/executor/queue');

const W = '0x65f001aa4109bb8d3bf70af66855aba1e5582625';

test('the executor refuses to start without keys and jobToRawConfig carries the snapshot', () => {
  assert.throws(() => assertExecutorKeys({}), /PRIVATE_KEY/);
  assert.doesNotThrow(() => assertExecutorKeys({ PRIVATE_KEY: '0xabc' }));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-config-'));
  const job = enqueueJob(dir, { chain: 'robinhood', contract: W, quantity: 2, codeHash: '0x' + 'ab'.repeat(32), startAtMs: 1_700_000_000_000 }, 1_000).job;
  const raw = jobToRawConfig(job);
  assert.equal(raw.chain, 'robinhood');
  assert.equal(raw.targets.length, 1);
  assert.equal(raw.targets[0].contract, W);
  assert.equal(raw.targets[0].slug, W, 'the contract is authoritative for the loader');
  assert.equal(raw.targets[0].quantity, 2);
  assert.equal(raw.targets[0].codeHash, '0x' + 'ab'.repeat(32), 'gate 1 keeps its pinned hash');
});

test('a job without a pinned hash, or with a stale one, is audited before signing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-audit-'));
  const base = enqueueJob(dir, { chain: 'robinhood', contract: W, quantity: 1 }, 1_000).job;
  assert.equal(needsAudit(base, 2_000), true, 'no snapshot yet');

  const fresh = { ...base, codeHash: '0x' + 'ab'.repeat(32), auditedAt: new Date(10_000).toISOString() };
  assert.equal(needsAudit(fresh, 11_000), false);
  assert.equal(needsAudit(fresh, 10_000 + 31 * 60_000), true, 'older than 30 minutes');
});

test('the queue result is derived from the ledger, never invented', () => {
  assert.equal(resultFromLedgerEntry(undefined, 't'), null);
  const result = resultFromLedgerEntry(
    { status: 'PARTIAL', txHash: '0xdead', at: 't', quantity: 2, slug: null, attempts: 1, mintedCount: 1, tokenIds: ['7'], gasBurnedWei: '123' },
    't2'
  );
  assert.equal(result.status, 'PARTIAL');
  assert.equal(result.mintedCount, 1);
  assert.deepEqual(result.tokenIds, ['7']);
  assert.equal(result.ledgerStatus, 'PARTIAL', 'the ledger wording is preserved for the panel');
});

test('"current" is resolved to the audited price and never reaches the loader', () => {
  const base = { maxPriceEth: "current" };
  assert.deepEqual(resolveMaxPriceEth({ ...base }, 1_500_000_000_000_000n), { maxPriceEth: "0.0015", resolved: true });
  assert.deepEqual(resolveMaxPriceEth({ ...base }, 0n), { maxPriceEth: "0", resolved: true }, "a free drop caps at 0");
  assert.deepEqual(resolveMaxPriceEth({ ...base }, null), { maxPriceEth: "current", resolved: false }, "unknown price cannot be resolved");
  assert.deepEqual(resolveMaxPriceEth({ maxPriceEth: "0.002" }, null), { maxPriceEth: "0.002", resolved: false }, "an explicit cap is left alone");

  const { parseEther } = require('ethers');
  assert.throws(() => parseEther("current"), /invalid/i, "the reason this matters");
  assert.doesNotThrow(() => parseEther("0.0015"));
});

test('queue jobs can opt into burst from the executor environment', () => {
  const job = { chain: "robinhood", contract: W, quantity: 1, maxPriceEth: "0", startAtMs: null, codeHash: null, slug: null, riskFlags: [] };
  assert.equal(jobToRawConfig(job, {}).burst, undefined, "burst stays off by default");
  const withBurst = jobToRawConfig(job, { BURST_COUNT: "2", BURST_ALLOW_OVERSHOOT: "1" });
  assert.deepEqual(withBurst.burst, { count: 2, allowOvershoot: true });
});

test('a not-applicable audit is reported as such, not as a gate-1 failure', () => {
  const { applicabilityError } = require('../dist/executor/run');
  assert.equal(applicabilityError({ applicable: true }), null);
  assert.equal(
    applicabilityError({ applicable: false }),
    'not applicable (no SeaDrop public drop)',
    'a reason is always produced'
  );
  assert.equal(
    applicabilityError({ applicable: false, notApplicableReason: 'no SeaDrop 1.0 public drop found' }),
    'no SeaDrop 1.0 public drop found'
  );
});
