const { test } = require('node:test');
const assert = require('node:assert/strict');
const { decodeMintLog, aggregateMints, splitWindows } = require('../dist/audit/events');
const {
  remainingSupply,
  gradeRemaining,
  projectedHeadroom,
  gradeProjected,
  isRateConfident,
  gradeTarget,
} = require('../dist/audit/score');
const fixture = require('./fixtures/seadropmint-arc.json');

const TOPIC = '0xe90cf9cc0a552cf52ea6ff74ece0f1c8ae8cc9ad630d3181f55ac43ca076b7d6';
const word = n => '0x' + BigInt(n).toString(16).padStart(64, '0');
const addrWord = a => word(BigInt(a));
const log = (nft, minter, feeRecipient, payer, qty, price, feeBps, stage, block) => ({
  topics: [TOPIC, addrWord(nft), addrWord(minter), addrWord(feeRecipient)],
  data: '0x' + [addrWord(payer), word(qty), word(price), word(feeBps), word(stage)].map(w => w.slice(2)).join(''),
  blockNumber: '0x' + BigInt(block).toString(16),
});

const A = '0x65f001aa4109bb8d3bf70af66855aba1e5582625';
const W1 = '0xf43bc9019c620c7eb82b43ada900cb7f535c58c2';
const W2 = '0x915f2b9985882513ff5a6fb9a9d853e9f2cb95e1';
const FEE = '0x0000a26b00c1f0df003000390027140000faa719';

test('decodes a captured Arc SeaDropMint log', () => {
  const mint = decodeMintLog(fixture.log);
  assert.equal(mint.nftContract.toLowerCase(), A);
  assert.equal(mint.minter.toLowerCase(), W1);
  assert.equal(mint.payer.toLowerCase(), W1);
  assert.equal(mint.quantity, 2n);
  assert.equal(mint.mintPrice, 0n);
  assert.equal(mint.feeBps, 1000);
  assert.equal(mint.stage, 0);
  assert.equal(mint.block, 21279829);
  assert.equal(decodeMintLog({ ...fixture.log, data: '0x1234' }), null);
});

test('aggregates mints per stage with unique minters and top share', () => {
  const logs = [
    log(A, W1, FEE, W1, 2, 0, 1000, 0, 100),
    log(A, W2, FEE, W2, 2, 0, 1000, 0, 101),
    log(A, W1, FEE, W1, 1, 10n ** 16n, 1000, 1, 105),
  ];
  const scan = aggregateMints(logs, 102);
  assert.equal(scan.totalTxs, 3);
  assert.equal(scan.totalTokens, 5n);
  assert.equal(scan.uniqueMinters, 2);
  assert.equal(scan.topMinterShare, 0.6);
  assert.equal(scan.firstBlock, 100);
  assert.equal(scan.lastBlock, 105);
  assert.equal(scan.recentTokens, 1n);
  assert.deepEqual(scan.stages.map(s => [s.stage, s.tokens, s.uniqueMinters]), [[0, 4n, 2], [1, 1n, 1]]);
});

test('splits block ranges per chain window', () => {
  assert.deepEqual(splitWindows(0, 2500, 1000), [
    { from: 0, to: 999 },
    { from: 1000, to: 1999 },
    { from: 2000, to: 2500 },
  ]);
  assert.deepEqual(splitWindows(10, 10, 1000), [{ from: 10, to: 10 }]);
});

test('retries a throttled window and keeps scanning the rest', async () => {
  const { scanLogs } = require('../dist/audit/events');
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls <= 2) throw new Error('Too Many Requests');
    return { json: async () => ({ result: [] }) };
  };
  try {
    const logs = await scanLogs('arc', '0x0000000000000000000000000000000000000000', [], 0, 9999, {
      rpcUrl: 'http://unused',
      concurrency: 1,
      maxRetries: 3,
    });
    assert.deepEqual(logs, []);
    assert.equal(calls, 4);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('headroom upper bound grades supply without any rate input', () => {
  assert.equal(remainingSupply(5000n, 5000n), 0n);
  assert.equal(remainingSupply(null, 10n), null);
  assert.equal(remainingSupply(0n, 10n), null);
  assert.equal(gradeRemaining(0n, 1n), 'C');
  assert.equal(gradeRemaining(1n, 1n), 'A');
  assert.equal(gradeRemaining(1n, 3n), 'B');
  assert.equal(gradeRemaining(null, 1n), 'B');
});

test('projected headroom subtracts the recent mint rate', () => {
  assert.equal(projectedHeadroom(100n, 30n, 15, 30), 40n);
  assert.equal(projectedHeadroom(100n, 30n, 15, 0), 100n);
  assert.equal(projectedHeadroom(null, 30n, 15, 30), null);
  assert.equal(gradeProjected(-1n, 1n, true), 'C');
  assert.equal(gradeProjected(-1n, 1n, false), 'B');
  assert.equal(gradeProjected(2n, 3n, true), 'B');
  assert.equal(gradeProjected(3n, 3n, true), 'A');
});

test('rate confidence needs both a long sample and enough mints', () => {
  assert.equal(isRateConfident(20n, 10), true);
  assert.equal(isRateConfident(19n, 15), false);
  assert.equal(isRateConfident(100n, 5), false);
});

const base = {
  maxSupply: 2222n,
  totalMinted: 2222n,
  requested: 1n,
  recentTokens: 0n,
  recentWindowMinutes: 15,
  minutesToPublic: 0,
  rateConfident: false,
  priceChanges: 0,
  startChanges: 0,
  lastPriceChangeAt: null,
  lastStartChangeAt: null,
  publicStartAt: 1_800_000_000,
  now: 1_800_000_000,
  topMinterShare: 0,
  socialKnown: false,
  socialAny: false,
  ageHours: null,
};

test('grades a sold-out target C on the upper bound alone', () => {
  const result = gradeTarget(base);
  assert.equal(result.grade, 'C');
  assert.equal(result.upperGrade, 'C');
  assert.match(result.upperReason, /all minted/);
});

test('flags a last-minute price change without capping the grade', () => {
  const result = gradeTarget({
    ...base,
    maxSupply: 5555n,
    totalMinted: 812n,
    priceChanges: 2,
    lastPriceChangeAt: base.publicStartAt - 1800,
  });
  assert.equal(result.grade, 'A');
  assert.ok(result.risks.some(r => r.includes('30m before open')));
});

test('only an API-known, brand-new, social-less collection reaches D', () => {
  const withApi = gradeTarget({ ...base, maxSupply: 100n, totalMinted: 0n, socialKnown: true, socialAny: false, ageHours: 5 });
  assert.equal(withApi.grade, 'D');
  const noApi = gradeTarget({ ...base, maxSupply: 100n, totalMinted: 0n });
  assert.equal(noApi.grade, 'A');
  const withSocial = gradeTarget({ ...base, maxSupply: 100n, totalMinted: 0n, socialKnown: true, socialAny: true, ageHours: 5 });
  assert.equal(withSocial.grade, 'A');
});
