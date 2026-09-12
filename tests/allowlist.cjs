const { test } = require('node:test');
const assert = require('node:assert/strict');
const { allowlistInterface: abi, validateAllowlistTx: validate } = require('../dist/allowlist');
const { SEADROP_ADDRESS } = require('../dist/seadrop-public');
const { hasLivePresale } = require('../dist/allowlist');
const contract = '0x200392a7794b004471cd65af1311cdc7375dd719';
const wallet = '0xbBb851191eAFFBd9eC85De950ACa19805f376547';
const zero = '0x0000000000000000000000000000000000000000';
const other = '0x1111111111111111111111111111111111111111';
function transaction(method = 'mintSigned', changes = {}) {
  const now = Math.floor(Date.now()/1000);
  const args = [changes.contract || contract, other, changes.minter || zero, 1,
    [2, 100, now - 60, changes.end || now + 600, 2, 1000, 1000, true]];
  if (method === 'mintSigned') args.push(1, '0x1234'); else args.push([]);
  return { to: SEADROP_ADDRESS, chain: 'robinhood', value: '2', data: abi.encodeFunctionData(method, args) };
}
const check = raw => validate(raw, contract, 'robinhood', wallet, 1);
test('accepts both allowlist methods, self payer and explicit wallet', () => {
  assert.equal(check(transaction()).method, 'mintSigned');
  assert.equal(check(transaction('mintAllowList', {minter:wallet})).method, 'mintAllowList');
});
test('rejects redirected funds, chain, collection, recipient, value and quantity', () => {
  for (const changes of [{to:other},{chain:'base'},{value:'3'},{data:'0x12345678'}])
    assert.throws(() => check({...transaction(),...changes}));
  assert.throws(() => check(transaction('mintSigned',{contract:other})));
  assert.throws(() => check(transaction('mintSigned',{minter:other})));
  assert.throws(() => validate(transaction(),contract,'robinhood',wallet,2));
  assert.throws(() => validate(transaction(),contract,'robinhood',wallet,1.5));
});
test('rejects expired stage', () => {
  assert.throws(() => check(transaction('mintSigned',{end:Math.floor(Date.now()/1000)-1})));
});
test('detects live presale with exact start/end boundaries, ignoring public and ended stages', () => {
  const stage = { stage_type:'signed_presale', start_time:'2026-09-12T03:06:00Z', end_time:'2026-09-22T03:07:00Z' };
  const start = Date.parse(stage.start_time), end = Date.parse(stage.end_time);
  assert.equal(hasLivePresale({stages:[stage]}, start), true);
  assert.equal(hasLivePresale({stages:[stage]}, start - 1), false);
  assert.equal(hasLivePresale({stages:[stage]}, end), false);
  assert.equal(hasLivePresale({stages:[{...stage,stage_type:'public_sale'}]}, start), false);
  assert.equal(hasLivePresale({stages:[{...stage,end_time:stage.start_time},stage]}, start), true);
  assert.throws(() => hasLivePresale({}));
  assert.throws(() => hasLivePresale({stages:[{...stage,start_time:'invalid'}]}));
});
