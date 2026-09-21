const { test } = require('node:test');
const assert = require('node:assert/strict');
const { planBurst, burstGate, aggregateBurst, calibrateLead, gapFillerTx, autoBurstForFreeCap1 } = require('../dist/burst');

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

test('calibrateLead observes a second boundary instead of trusting a truncated timestamp', async () => {
  // A fake chain: the block timestamp steps by one second when the local clock
  // crosses a boundary, the local clock is 120ms behind it, and blocks arrive
  // every 100ms. The old formula (now - ts*1000) would read +900ms here.
  const skewMs = 120;
  const blockIntervalMs = 100;
  let localNow = 1_758_000_000_000;
  const sleep = async (ms) => {
    localNow += ms;
  };
  const fetchFn = async (_url, init) => {
    const body = JSON.parse(String(init.body));
    if (body.method === "eth_blockNumber") {
      return { ok: true, json: async () => ({ result: "0x" + Math.floor(localNow / blockIntervalMs).toString(16) }) };
    }
    const ts = Math.floor((localNow - skewMs) / 1000);
    return { ok: true, json: async () => ({ result: { number: "0x1", timestamp: String(ts) } }) };
  };

  const calibrated = await calibrateLead({
    rpcUrls: ['https://rpc.example'],
    now: () => localNow,
    sleep,
    fetchFn,
    measureRtt: async () => 60,
    timeoutMs: 3000,
  });
  assert.equal(calibrated.rttMs, 60);
  assert.ok(calibrated.clockSkewMs !== null, 'the boundary was observed');
  assert.ok(
    Math.abs(calibrated.clockSkewMs - skewMs) <= 150,
    `skew ${calibrated.clockSkewMs} should be within 150ms of ${skewMs}`
  );
  assert.equal(calibrated.suspectClock, false);
  assert.equal(calibrated.leadMs, 60 + Math.max(0, calibrated.clockSkewMs) + 50, 'rtt + skew + margin');

  // No boundary observed (a slow or stuck RPC): skew is unknown, and the gate
  // must not randomly disable the burst because of an unmeasurable clock.
  const blind = await calibrateLead({
    rpcUrls: ['https://rpc.example'],
    now: () => localNow,
    sleep,
    fetchFn: async (_url, init) => {
      const body = JSON.parse(String(init.body));
      if (body.method === "eth_blockNumber") return { ok: true, json: async () => ({ result: "0x1" }) };
      return { ok: true, json: async () => ({ result: { number: "0x1", timestamp: "1758000000" } }) };
    },
    measureRtt: async () => 40,
    timeoutMs: 500,
  });
  assert.equal(blind.clockSkewMs, null);
  assert.equal(blind.suspectClock, false);
  assert.equal(blind.leadMs, 40 + 50, 'rtt + margin only');

  const gate = burstGate({ count: 3, capPerWallet: 1, allowOvershoot: false, clockSkewMs: blind.clockSkewMs, leadMs: blind.leadMs });
  assert.equal(gate.allowed, true, 'an unknown clock is not a reason to refuse');
  assert.match(gate.reason, /unknown/i);
});

test('gapFillerTx builds a zero-value self transfer on the missing nonce', () => {
  const filler = gapFillerTx({
    wallet: '0x65f001aa4109bb8d3bf70af66855aba1e5582625',
    nonce: 15,
    gasLimit: 250_000,
    maxFeePerGas: 2_000_000_000n,
    maxPriorityFeePerGas: 50_000_000n,
    chainId: 4663n,
  });
  assert.equal(filler.to, '0x65f001aa4109bb8d3bf70af66855aba1e5582625'.toLowerCase());
  assert.equal(filler.value, 0n, 'filling a hole must not spend value');
  assert.equal(filler.data, '0x');
  assert.equal(filler.nonce, 15);
  assert.equal(filler.gasLimit, 250_000);
  assert.equal(filler.chainId, 4663n);
});

test('auto burst only fires on a free drop whose cap is one', () => {
  const base = { requested: 1, auto: true, mintPriceWei: 0n, capPerWallet: 1 };
  assert.deepEqual(autoBurstForFreeCap1(base), { count: 3, reason: 'free drop, cap 1 → auto burst' });
  // Explicit requests win.
  assert.equal(autoBurstForFreeCap1({ ...base, requested: 4 }).count, 4);
  // Anything paid, or a cap that allows several, stays a single shot.
  assert.equal(autoBurstForFreeCap1({ ...base, mintPriceWei: 1n }).count, 1);
  assert.equal(autoBurstForFreeCap1({ ...base, capPerWallet: 5 }).count, 1);
  assert.equal(autoBurstForFreeCap1({ ...base, capPerWallet: null }).count, 1);
  // The switch turns it off.
  assert.equal(autoBurstForFreeCap1({ ...base, auto: false }).count, 1);
  // The auto count stays inside the burst bound.
  assert.equal(autoBurstForFreeCap1({ ...base, autoCount: 99 }).count, 5);
});
