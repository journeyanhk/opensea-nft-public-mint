const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveChain, CHAINS } = require('../dist/chains');
const { resolveGas } = require('../dist/batch-config');
const { parseNftLink } = require('../dist/nft-link');
const { resolveRpcsForChain } = require('../dist/rpc-resolver');

test('registers Arc with its gas defaults and explorer', () => {
  const arc = resolveChain('arc');
  assert.equal(arc.chainId, 5042);
  assert.equal(arc.nativeSymbol, 'USDC');
  assert.equal(arc.explorer, 'https://explorer.arc.io');
  assert.deepEqual(arc.gas, { maxFeeGwei: 40, priorityGwei: 0 });
  assert.equal(resolveChain(5042).key, 'arc');
  assert.ok(CHAINS.every(c => c.gas && Number.isFinite(c.gas.maxFeeGwei) && Number.isFinite(c.gas.priorityGwei)));
});

test('per-chain gas defaults match the values the old ternary hardcoded', () => {
  assert.deepEqual(resolveChain('ethereum').gas, { maxFeeGwei: 80, priorityGwei: 5 });
  assert.deepEqual(resolveChain('base').gas, { maxFeeGwei: 2, priorityGwei: 0.05 });
  assert.deepEqual(resolveChain('robinhood').gas, { maxFeeGwei: 2, priorityGwei: 0.05 });
});

test('resolveGas falls back to the chain defaults when .env says nothing', () => {
  const saved = {
    MAX_FEE_PER_GAS: process.env.MAX_FEE_PER_GAS,
    MAX_PRIORITY_FEE: process.env.MAX_PRIORITY_FEE,
    GAS_LIMIT: process.env.GAS_LIMIT,
  };
  try {
    delete process.env.MAX_FEE_PER_GAS;
    delete process.env.MAX_PRIORITY_FEE;
    delete process.env.GAS_LIMIT;
    const arc = resolveGas('arc', {});
    assert.equal(arc.maxFeePerGas, 40000000000n);
    assert.equal(arc.maxPriorityFee, 0n);
    assert.equal(arc.gasLimit, 250000);
    assert.equal(resolveGas('ethereum', {}).maxFeePerGas, 80000000000n);
    assert.equal(resolveGas('robinhood', {}).maxPriorityFee, 50000000n);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('parses an Arc asset link and finds its public RPC', () => {
  const link = parseNftLink('https://opensea.io/assets/arc/0x0000a26b00c1F0DF003000390027140000fAa719/1');
  assert.equal(link.kind, 'address');
  assert.equal(link.chainHint, 'arc');
  assert.ok(resolveRpcsForChain('arc').urls.includes('https://rpc.mainnet.arc.io'));
});
