const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Wallet, Interface, keccak256 } = require('ethers');
const { validateSignedTx, validateMintPublicCalldata, classifySimulation, codeHashOf } = require('../dist/gates');

const SEADROP = '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5';
const NFT = '0x65f001aa4109bb8d3bf70af66855aba1e5582625';
const FEE = '0x0000a26b00c1f0df003000390027140000faa719';
const QUANTITY = 2n;

const iface = new Interface([
  'function mintPublic(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity) payable',
]);
const calldata = (nft = NFT, fee = FEE, quantity = QUANTITY) =>
  iface.encodeFunctionData('mintPublic', [nft, fee, '0x0000000000000000000000000000000000000000', quantity]);

test('validateSignedTx accepts an honest transaction and rejects every tamper', async () => {
  const wallet = Wallet.createRandom();
  const expected = {
    from: wallet.address,
    chainId: 4663n,
    to: SEADROP,
    nonce: 7,
    data: calldata(),
    value: 0n,
    gasLimit: 250_000n,
    maxFeePerGas: 2_000_000_000n,
    maxPriorityFeePerGas: 50_000_000n,
  };
  const raw = await wallet.signTransaction({
    to: expected.to,
    data: expected.data,
    value: expected.value,
    nonce: expected.nonce,
    gasLimit: expected.gasLimit,
    maxFeePerGas: expected.maxFeePerGas,
    maxPriorityFeePerGas: expected.maxPriorityFeePerGas,
    type: 2,
    chainId: Number(expected.chainId),
  });
  assert.deepEqual(validateSignedTx(raw, expected), { ok: true, errors: [] });

  assert.equal(validateSignedTx(raw, { ...expected, nonce: 8 }).ok, false);
  assert.ok(validateSignedTx(raw, { ...expected, nonce: 8 }).errors.join().includes('nonce'));
  assert.equal(validateSignedTx(raw, { ...expected, value: 1n }).ok, false);
  assert.equal(validateSignedTx(raw, { ...expected, to: NFT }).ok, false);
  assert.equal(validateSignedTx(raw, { ...expected, from: SEADROP }).ok, false);
  assert.equal(validateSignedTx('0xdead', expected).ok, false, 'garbage is rejected, not thrown');

  // The dangerous case: a signed payload whose calldata says something else.
  const tampered = await wallet.signTransaction({
    to: expected.to,
    data: calldata(NFT, FEE, 999n),
    value: 0n,
    nonce: 7,
    gasLimit: 250_000n,
    maxFeePerGas: 2_000_000_000n,
    maxPriorityFeePerGas: 50_000_000n,
    type: 2,
    chainId: 4663,
  });
  assert.equal(validateSignedTx(tampered, expected).ok, false);
});

test('validateMintPublicCalldata decodes and checks nft, fee recipient and quantity', () => {
  const expected = { nftContract: NFT, feeRecipient: FEE, quantity: QUANTITY };
  assert.deepEqual(validateMintPublicCalldata(calldata(), expected), { ok: true, errors: [] });
  assert.equal(validateMintPublicCalldata(calldata(NFT, FEE, 3n), expected).ok, false);
  assert.equal(validateMintPublicCalldata(calldata(SEADROP, FEE), expected).ok, false);
  assert.equal(validateMintPublicCalldata(calldata(NFT, NFT), expected).ok, false);
  // minterIfNotPayer must stay zero: we are the payer.
  const deferred = iface.encodeFunctionData('mintPublic', [NFT, FEE, SEADROP, QUANTITY]);
  assert.equal(validateMintPublicCalldata(deferred, expected).ok, false);
  assert.equal(validateMintPublicCalldata('0x1234', expected).ok, false);
});

test('classifySimulation passes a pre-open revert but blocks a post-open one', () => {
  assert.equal(classifySimulation({ ok: true, errorText: null, stageOpen: false }).pass, true);
  const pre = classifySimulation({ ok: false, errorText: 'execution reverted: NotActive', stageOpen: false });
  assert.equal(pre.pass, true, 'before the stage opens any revert is expected');
  const post = classifySimulation({ ok: false, errorText: 'execution reverted', stageOpen: true });
  assert.equal(post.pass, false, 'once open, a revert means this wallet cannot mint');
  const payment = classifySimulation({ ok: false, errorText: 'execution reverted: IncorrectPayment', stageOpen: false });
  assert.equal(payment.pass, false, 'a named payment error is fatal even before open');
  assert.match(payment.label, /payment/i);
  const cap = classifySimulation({ ok: false, errorText: 'execution reverted: MintQuantityExceedsMaxSupply', stageOpen: false });
  assert.equal(cap.pass, false);
  const recipient = classifySimulation({ ok: false, errorText: 'execution reverted: FeeRecipientNotAllowed', stageOpen: false });
  assert.equal(recipient.pass, false);
});

test('codeHashOf hashes bytecode and treats an empty account as dangerous', () => {
  const hash = codeHashOf('0x6001600155');
  assert.match(hash, /^0x[0-9a-f]{64}$/);
  assert.equal(hash, keccak256('0x6001600155'));
  assert.equal(codeHashOf('0x'), null, 'no code means the contract is gone');
  assert.equal(codeHashOf(''), null);
});

test('simulation errors decode by SeaDrop selector, not by error text', () => {
  const { decodeSeaDropError, revertDataOf } = require('../dist/gates');
  const { Interface } = require('ethers');

  // Real selectors: 4byte/keccak-verified signatures used by SeaDrop.
  const errors = new Interface([
    'error NotActive()',
    'error NotActive(uint256,uint256,uint256)',
    'error IncorrectPayment(uint256,uint256)',
    'error MintQuantityExceedsMaxSupply(uint256,uint256)',
    'error MintQuantityExceedsMaxMintedPerWallet(uint256,uint256)',
    'error FeeRecipientNotAllowed()',
  ]);
  const dataFor = (sig, args = []) => {
    const fragment = errors.getError(sig);
    return errors.encodeErrorResult(fragment, args);
  };
  assert.equal(decodeSeaDropError(dataFor('NotActive()')), 'NotActive');
  assert.equal(decodeSeaDropError(dataFor('NotActive(uint256,uint256,uint256)', [1n, 2n, 3n])), 'NotActive');
  assert.equal(decodeSeaDropError(dataFor('IncorrectPayment', [1n, 2n])), 'IncorrectPayment');
  assert.equal(decodeSeaDropError(dataFor('FeeRecipientNotAllowed()')), 'FeeRecipientNotAllowed');
  assert.equal(decodeSeaDropError('0xdeadbeef'), null);
  assert.equal(decodeSeaDropError(null), null);

  // Revert data arrives in several shapes depending on the node/provider.
  assert.equal(revertDataOf({ data: '0x12345678' }), '0x12345678');
  assert.equal(revertDataOf({ info: { error: { data: '0x56789012' } } }), '0x56789012');
  assert.equal(revertDataOf({ info: { error: { message: 'execution reverted: 0x9abcdef0' } } }), '0x9abcdef0');
  assert.equal(revertDataOf({ shortMessage: 'execution reverted' }), null);

  const { classifySimulation } = require('../dist/gates');
  const active = dataFor('NotActive()');
  assert.equal(classifySimulation({ ok: false, revertData: active, stageOpen: false }).pass, true);
  assert.match(classifySimulation({ ok: false, revertData: active, stageOpen: false }).label, /pre-open/i);

  const payment = classifySimulation({ ok: false, revertData: dataFor('IncorrectPayment', [1n, 2n]), stageOpen: false });
  assert.equal(payment.pass, false, 'a decoded payment error is fatal even before the open');
  assert.match(payment.label, /IncorrectPayment/);

  const cap = classifySimulation({ ok: false, revertData: dataFor('MintQuantityExceedsMaxMintedPerWallet', [1n, 2n]), stageOpen: false });
  assert.equal(cap.pass, false);
  assert.match(cap.label, /MaxMintedPerWallet/);

  // Unknown selector once open still blocks, and says which selector it was.
  const unknown = classifySimulation({ ok: false, revertData: '0xdeadbeef', stageOpen: true });
  assert.equal(unknown.pass, false);
  assert.match(unknown.label, /0xdeadbeef/);
});
