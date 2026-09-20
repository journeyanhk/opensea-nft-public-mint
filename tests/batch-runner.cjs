const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('a dry run never writes the ledger', () => {
  const { shouldWriteLedger } = require('../dist/batch-runner');
  assert.equal(shouldWriteLedger(true, true), false, 'dry run: no PENDING, no final entry');
  assert.equal(shouldWriteLedger(true, false), true);
  assert.equal(shouldWriteLedger(false, false), false, '--no-ledger stays off');
});

test('every ledger write in batch-runner goes through that guard', () => {
  // A PENDING entry from a dry run reads as "maybe on chain" and silently
  // blocks the next real run — this invariant stops the next unguarded write.
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'batch-runner.ts'), 'utf8');
  const writes = (source.match(/recordEntry\(/g) || []).length;
  const guards = (source.match(/shouldWriteLedger\(useLedger, cfg\.dryRun\)/g) || []).length;
  assert.ok(writes >= 3, `expected the three ledger call sites, found ${writes}`);
  assert.equal(guards, writes, 'every recordEntry must sit behind shouldWriteLedger');
});
