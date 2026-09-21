const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { jobToRawConfig, needsAudit, resultFromLedgerEntry, assertExecutorKeys } = require('../dist/executor/run');
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
