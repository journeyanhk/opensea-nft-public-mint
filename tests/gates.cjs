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
