const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Interface } = require('ethers');
const { countMintedTokens, verdict } = require('../dist/receipts');

const NFT = '0x65f001aa4109bb8d3bf70af66855aba1e5582625';
const OTHER = '0x1111111111111111111111111111111111111111';
const WALLET = '0xf43bc9019c620c7eb82b43ada900cb7f535c58c2';
const ZERO = '0x0000000000000000000000000000000000000000';

const erc721 = new Interface(['event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)']);
const erc1155 = new Interface([
  'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)',
  'event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)',
]);

const log721 = (from, to, tokenId, address = NFT) => ({
  address,
  ...erc721.encodeEventLog(erc721.getEvent('Transfer'), [from, to, tokenId]),
});
const log1155 = (from, to, id, value, address = NFT) => ({
  address,
  ...erc1155.encodeEventLog(erc1155.getEvent('TransferSingle'), [ZERO, from, to, id, value]),
});
const log1155Batch = (from, to, ids, values, address = NFT) => ({
  address,
  ...erc1155.encodeEventLog(erc1155.getEvent('TransferBatch'), [ZERO, from, to, ids, values]),
});

test('countMintedTokens counts only mints of this contract to this wallet', () => {
  const receipt = {
    logs: [
      log721(ZERO, WALLET, 101),
      log721(ZERO, WALLET, 102),
      log721(ZERO, OTHER, 103), // someone else's token
      log721(WALLET, OTHER, 104), // a transfer out, not a mint
      log721(ZERO, WALLET, 105, OTHER), // another collection's mint
    ],
  };
  const minted = countMintedTokens(receipt, { nftContract: NFT, wallet: WALLET });
  assert.equal(minted.count, 2);
  assert.deepEqual(minted.tokenIds.sort(), ['101', '102']);
  assert.equal(minted.kind, 'ERC721');
});

test('countMintedTokens handles ERC-1155 single and batch mints', () => {
  const receipt = {
    logs: [
      log1155(ZERO, WALLET, 7, 3),
      log1155Batch(ZERO, WALLET, [8, 9], [2, 5]),
    ],
  };
  const minted = countMintedTokens(receipt, { nftContract: NFT, wallet: WALLET });
  assert.equal(minted.count, 10);
  assert.deepEqual(minted.tokenIds.sort(), ['7', '8', '9']);
  assert.equal(minted.kind, 'ERC1155');
});

test('verdict separates a real mint from a success with zero tokens', () => {
  assert.equal(verdict('SUCCESS', 2, 2), 'MINTED');
  assert.equal(verdict('SUCCESS', 3, 2), 'MINTED');
  assert.equal(verdict('SUCCESS', 1, 2), 'PARTIAL');
  assert.equal(verdict('SUCCESS', 0, 1), 'NO_MINT');
  assert.equal(verdict('REVERTED', 0, 1), 'REVERTED');
  assert.equal(verdict('REVERTED', 1, 2), 'PARTIAL', 'a revert cannot have minted, but if it did, report it');
});

test('PARTIAL and NO_MINT are terminal: the chain was touched, never resend', () => {
  const { shouldSkipLedger } = require('../dist/batch-ledger');
  assert.equal(shouldSkipLedger({ status: 'PARTIAL', txHash: '0x1', at: 't', quantity: 2, slug: null, attempts: 1, mintedCount: 1 }), true);
  assert.equal(shouldSkipLedger({ status: 'NO_MINT', txHash: '0x1', at: 't', quantity: 1, slug: null, attempts: 1, mintedCount: 0 }), true);
});
