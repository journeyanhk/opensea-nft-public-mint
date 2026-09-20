const { test } = require('node:test');
const assert = require('node:assert/strict');
const { planBurst, burstGate, aggregateBurst, calibrateLead } = require('../dist/burst');

test('planBurst hands out one nonce per shot, in order', () => {
  assert.deepEqual(planBurst(15, 1), [15]);
  assert.deepEqual(planBurst(15, 4), [15, 16, 17, 18]);
  assert.deepEqual(planBurst(0, 2), [0, 1]);
});

test('burstGate only lets a burst through when it cannot overshoot or is allowed to', () => {
  const base = { count: 4, capPerWallet: 1, allowOvershoot: false, clockSkewMs: 120, leadMs: 180 };

  assert.equal(burstGate(base).allowed, true, 'cap 1: only one shot can land, the rest revert');
  assert.equal(burstGate({ ...base, count: 1 }).allowed, false, 'a single shot is not a burst');

  const multi = burstGate({ ...base, capPerWallet: 5 });
  assert.equal(multi.allowed, false);
  assert.match(multi.reason, /overshoot|allow/i);
  assert.equal(burstGate({ ...base, capPerWallet: 5, allowOvershoot: true }).allowed, true);

  const unknownCap = burstGate({ ...base, capPerWallet: null });
  assert.equal(unknownCap.allowed, false, 'an unknown cap is treated like a multi-mint cap');

  const skewed = burstGate({ ...base, clockSkewMs: 900 });
  assert.equal(skewed.allowed, false);
  assert.match(skewed.reason, /clock/i);
  assert.equal(burstGate({ ...base, clockSkewMs: 900, forceClock: true }).allowed, true);

  const tooLate = burstGate({ ...base, leadMs: 0 });
  assert.equal(tooLate.allowed, false, 'a zero lead is not a burst');
  assert.equal(burstGate({ ...base, count: 0 }).allowed, false);
  assert.equal(burstGate({ ...base, count: 9 }).allowed, false, 'keep the burst bounded');
});

test('aggregateBurst keeps the shot that landed and accounts for every bit of gas', () => {
  const shots = [
    { txHash: '0xaa', status: 'REVERTED', mintedCount: 0, gasBurnedWei: '25000' },
    { txHash: '0xbb', status: 'SUCCESS', mintedCount: 1, tokenIds: ['7'], gasBurnedWei: '101892' },
    { txHash: '0xcc', status: 'REVERTED', mintedCount: 0, gasBurnedWei: '25000' },
    { txHash: '0xdd', status: 'REVERTED', mintedCount: 0, gasBurnedWei: '25000' },
  ];
  const result = aggregateBurst(shots);
  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.mintedCount, 1);
  assert.deepEqual(result.tokenIds, ['7']);
  assert.equal(result.txHash, '0xbb');
  assert.equal(result.gasBurnedWei, '176892', 'expected reverts still burn gas');
  assert.deepEqual(result.txHashes, ['0xaa', '0xbb', '0xcc', '0xdd']);

  // Nothing landed: the receipt said success but minted zero — that is NO_MINT.
  const nothing = aggregateBurst([
    { txHash: '0x1', status: 'REVERTED', mintedCount: 0, gasBurnedWei: '25000' },
    { txHash: '0x2', status: 'NO_MINT', mintedCount: 0, gasBurnedWei: '38000' },
  ]);
  assert.equal(nothing.status, 'NO_MINT');
  assert.equal(nothing.mintedCount, 0);

  const allReverted = aggregateBurst([{ txHash: '0x1', status: 'REVERTED', mintedCount: 0, gasBurnedWei: '25000' }]);
  assert.equal(allReverted.status, 'REVERTED');
});

test('calibrateLead measures RTT and clock skew from the latest block', async () => {
  // 200ms past a second boundary keeps the second-granular block timestamp
  // honest: the truncation error stays inside the range we assert.
  const now = 1_758_000_000_200;
  const calibrated = await calibrateLead({
    rpcUrls: ['https://rpc.example'],
    now: () => now,
    rounds: 3,
    measureRtt: async () => 50,
    fetchFn: async () => ({
      ok: true,
      json: async () => ({ result: { number: '0x1', timestamp: String(Math.floor((now - 120) / 1000)) } }),
    }),
  });
  assert.equal(calibrated.rttMs, 50);
  // Block timestamps are second-granular, so the skew estimate is 120ms plus
  // the truncation error; the invariant that matters is the lead formula.
  assert.ok(calibrated.clockSkewMs >= 120 && calibrated.clockSkewMs < 1120, `skew ${calibrated.clockSkewMs}`);
  assert.equal(calibrated.leadMs, 50 + Math.max(0, calibrated.clockSkewMs) + 50, 'rtt + skew + margin');
  assert.equal(calibrated.suspectClock, false);

  const skewed = await calibrateLead({
    rpcUrls: ['https://rpc.example'],
    now: () => now,
    rounds: 1,
    measureRtt: async () => 40,
    fetchFn: async () => ({
      ok: true,
      json: async () => ({ result: { number: '0x1', timestamp: String(Math.floor((now - 900) / 1000)) } }),
    }),
  });
  assert.equal(skewed.suspectClock, true, 'a 900ms skew is not trustworthy');
});
