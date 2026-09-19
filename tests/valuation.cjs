const { test } = require('node:test');
const assert = require('node:assert/strict');
const { conservativeValuation, liquidityVerdict } = require('../dist/scan/valuation');

const nowMs = Date.parse('2026-09-19T12:00:00.000Z');
const sale = (hoursAgo, value, buyer, tx) => ({
  value,
  buyer,
  txHash: "0x" + String(tx).replace(/^0x/, "").padStart(64, "0"),
  atMs: nowMs - hoursAgo * 3_600_000,
});

test('conservativeValuation refuses a reference price on thin evidence', () => {
  // Two transactions by two buyers is not enough.
  const thin = conservativeValuation({
    sales: [sale(1, 1, '0xa', '0x1'), sale(2, 1.2, '0xb', '0x2')],
    floor: 5,
    topOffer: 4,
    nowMs,
  });
  assert.equal(thin.supported, false);
  assert.equal(thin.reference, null);
  assert.match(thin.reason, /成交依据不足/);

  // Stale evidence (nothing in the last 6 hours) is not enough either.
  const stale = conservativeValuation({
    sales: [sale(10, 1, '0xa', '0x1'), sale(11, 1, '0xb', '0x2'), sale(12, 1, '0xc', '0x3')],
    floor: 5,
    topOffer: 4,
    nowMs,
  });
  assert.equal(stale.supported, false);
});

test('conservativeValuation weights buyers equally and discounts the lower quartile', () => {
  // One bulk buyer moves five sales; three small buyers set the real level.
  const result = conservativeValuation({
    sales: [
      sale(1, 0.9, '0xbulk', '0x1'),
      sale(1, 1.1, '0xbulk', '0x2'),
      sale(2, 1.0, '0xbulk', '0x3'),
      sale(2, 0.8, '0xa', '0x4'),
      sale(3, 0.7, '0xb', '0x5'),
      sale(3, 0.6, '0xc', '0x6'),
    ],
    floor: 2,
    topOffer: 1.5,
    nowMs,
  });
  assert.equal(result.supported, true);
  assert.equal(result.independentTransactions, 6);
  assert.equal(result.pricedBuyers, 4);
  // Buyer medians: 0.6, 0.7, 0.8, 1.0 (bulk contributes one) -> lower quartile
  // index floor((n-1)*0.25) = 0, i.e. 0.6, mirroring mint-desk.
  assert.ok(Math.abs(result.lowerQuartile - 0.6) < 1e-9);
  // reference = min(floor 2, 0.6*0.8=0.48, topOffer 1.5)
  assert.ok(Math.abs(result.reference - 0.48) < 1e-9);
});

test('conservativeValuation flags a floor far above the traded level', () => {
  const result = conservativeValuation({
    sales: [sale(1, 0.5, '0xa', '0x1'), sale(2, 0.5, '0xb', '0x2'), sale(3, 0.5, '0xc', '0x3')],
    floor: 10,
    topOffer: 9,
    nowMs,
  });
  assert.equal(result.floorDivergence, true);
});

test('liquidityVerdict summarises what our own backfill saw', () => {
  const fresh = liquidityVerdict({ salesCount: 5, uniqueBuyers: 3, checkedAtMs: nowMs - 3_600_000 }, nowMs);
  assert.equal(fresh.level, 'traded');
  const thin = liquidityVerdict({ salesCount: 1, uniqueBuyers: 1, checkedAtMs: nowMs - 3_600_000 }, nowMs);
  assert.equal(thin.level, 'thin');
  const old = liquidityVerdict({ salesCount: 9, uniqueBuyers: 4, checkedAtMs: nowMs - 30 * 3_600_000 }, nowMs);
  assert.equal(old.level, 'stale-evidence');
  assert.equal(liquidityVerdict(null, nowMs).level, 'unknown');
});
