const { test } = require('node:test');
const assert = require('node:assert/strict');
const { freeQuantityFor } = require('../dist/quantity');

test('free drops take the per-wallet cap, paid drops take one', () => {
  // A free drop with a cap of 10 and a ceiling of 5: mint 5.
  assert.deepEqual(freeQuantityFor({ mintPriceWei: 0n, capPerWallet: 10, freeMaxQuantity: 5 }), {
    quantity: 5,
    reason: 'free drop, per-wallet cap 10 → 5',
  });
  // A cap below the ceiling is the cap.
  assert.equal(freeQuantityFor({ mintPriceWei: 0n, capPerWallet: 2, freeMaxQuantity: 5 }).quantity, 2);
  // No cap (SeaDrop 0): the ceiling is the answer.
  assert.equal(freeQuantityFor({ mintPriceWei: 0n, capPerWallet: 0, freeMaxQuantity: 5 }).quantity, 5);
  // Any price at all and the quantity is one, whatever the cap says.
  assert.equal(freeQuantityFor({ mintPriceWei: 1n, capPerWallet: 10, freeMaxQuantity: 5 }).quantity, 1);
  // The policy can be switched off.
  assert.equal(freeQuantityFor({ mintPriceWei: 0n, capPerWallet: 10, freeMaxQuantity: 0 }).quantity, 1);
  assert.equal(freeQuantityFor({ mintPriceWei: 0n, capPerWallet: 0, freeMaxQuantity: -3 }).quantity, 1);
});

test('the gas limit grows with the quantity, never shrinks', () => {
  const { gasLimitForQuantity } = require('../dist/quantity');
  // A one-token mint keeps the configured limit (this is what the balance reserve assumed).
  assert.equal(gasLimitForQuantity(250_000, 1), 250_000);
  // More tokens need more gas: 5 x 150k + 60k overhead.
  assert.equal(gasLimitForQuantity(250_000, 5), 810_000);
  // A generous configured limit is respected, not reduced.
  assert.equal(gasLimitForQuantity(2_000_000, 5), 2_000_000);
  assert.equal(gasLimitForQuantity(250_000, 0), 250_000, 'a degenerate quantity does not shrink the limit');
});

test('thin supply takes one, because SeaDrop reverts the whole transaction', () => {
  const { downgradeForTightSupply, riskAdjustedQuantity } = require('../dist/quantity');
  // 5 left, 10 requested: ask for one instead of losing everything.
  assert.deepEqual(downgradeForTightSupply({ quantity: 10, remaining: 5n }), {
    quantity: 1,
    reason: 'supply is thin (5 left for 10 requested) — taking one instead',
  });
  // 200 left for 10 requested: plenty.
  assert.equal(downgradeForTightSupply({ quantity: 10, remaining: 200n }).quantity, 10);
  assert.equal(downgradeForTightSupply({ quantity: 10, remaining: 200n }).reason, null);
  // Unknown supply leaves the decision to the on-chain check.
  assert.equal(downgradeForTightSupply({ quantity: 10, remaining: null }).quantity, 10);
  // A single ticket is always fine.
  assert.equal(downgradeForTightSupply({ quantity: 1, remaining: 0n }).quantity, 1);

  assert.equal(riskAdjustedQuantity(10, ['batch-mint']), 1);
  assert.equal(riskAdjustedQuantity(10, ['instant-sellout']), 1);
  assert.equal(riskAdjustedQuantity(10, ['stale']), 10);
  assert.equal(riskAdjustedQuantity(10, []), 10);
});

test('a grade without a plan is not vouched for on the board', () => {
  const { loadDashboardRows, renderDashboard } = require('../dist/scan/html');
  const now = Math.floor(Date.now() / 1000);
  const state = {
    version: 1,
    chains: {},
    contracts: {
      arc: {
        '0xnoPlan': {
          firstSeenBlock: 1, lastSeenBlock: 10, lastAuditedBlock: 10, lastAuditedAt: '2026-09-19T08:00:00.000Z',
          lastGrade: 'B', soldOutAtBlock: null, publicStart: now + 3600, pendingAudit: false, slug: 'x', name: 'X',
          endTime: null, maxSupply: null, totalMinted: null, owner: null, socialCheckedAt: null,
          sources: [], calendar: null, codeHash: null, mintPriceWei: null, capPerWallet: null, feeRecipient: null,
        },
        '0xwithPlan': {
          firstSeenBlock: 1, lastSeenBlock: 10, lastAuditedBlock: 10, lastAuditedAt: '2026-09-19T08:00:00.000Z',
          lastGrade: 'A', soldOutAtBlock: null, publicStart: now + 3600, pendingAudit: false, slug: 'y', name: 'Y',
          endTime: null, maxSupply: '100', totalMinted: '0', owner: null, socialCheckedAt: null,
          sources: [], calendar: null, codeHash: null, mintPriceWei: '0', capPerWallet: 2, feeRecipient: null,
        },
      },
    },
  };
  const rows = loadDashboardRows(state, [], { version: 1, entries: {} }, () => null);
  assert.equal(rows.find((row) => row.contract === '0xnoPlan').grade, null, 'no plan, no grade');
  assert.equal(rows.find((row) => row.contract === '0xwithPlan').grade, 'A');
  const html = renderDashboard(rows, { generatedAt: 'now', sources: [] });
  assert.ok(html.includes('data-grade=""'), 'the plan-less row filters as ungraded');
});
