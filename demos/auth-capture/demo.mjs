import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createPublicClient, createWalletClient, http, decodeEventLog, encodeAbiParameters, keccak256, stringToHex, zeroAddress, formatUnits } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { ADDRESSES as A, CHAIN_ID, FORK_BLOCK, SOURCE_COMMIT, escrowAbi, tokenAbi, receiveTypes, json } from './contracts.mjs';

// Funding and time travel below are available only on a local Anvil fork.
const rpc = process.env.LOCAL_RPC || 'http://127.0.0.1:18545';
const url = new URL(rpc);
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Demo accepts localhost only');
const transport = http(rpc);
const client = createPublicClient({ chain: baseSepolia, transport });
const version = await client.request({ method: 'web3_clientVersion' });
assert.match(version, /anvil/i, 'Demo requires Anvil');
assert.equal(await client.getChainId(), CHAIN_ID);
const metadata = await client.request({ method: 'anvil_metadata' });
assert.equal(BigInt(metadata.forkedNetwork.forkBlockNumber), FORK_BLOCK, 'Restart at the documented fork block');
const sourceBlock = await client.getBlock({ blockNumber: FORK_BLOCK });
const snapshot = await client.request({ method: 'evm_snapshot' });
const actors = Object.fromEntries(['operator', 'payer', 'merchant', 'fee'].map(name => [name, privateKeyToAccount(generatePrivateKey())]));
const addresses = Object.fromEntries(Object.entries(actors).map(([k, v]) => [k, v.address]));
const wallet = account => createWalletClient({ account, chain: baseSepolia, transport });
const readToken = (functionName, args = []) => client.readContract({ address: A.usdc, abi: tokenAbi, functionName, args });
const readEscrow = (functionName, args = []) => client.readContract({ address: A.escrow, abi: escrowAbi, functionName, args });
const report = { mode: 'local-anvil-fork', generatedAt: new Date().toISOString(), clientVersion: version, chainId: CHAIN_ID, forkBlock: FORK_BLOCK, forkBlockHash: sourceBlock.hash, sourceCommit: SOURCE_COMMIT, contracts: A, actors: addresses, publicTransactionsSent: 0, funding: 'Local fork only: impersonate USDC masterMinter, configure a temporary minter, mint test balances. Deployed payment contract code is not replaced.', setup: [], steps: [], negativeChecks: [] };
let tokenStore;

async function transact(account, address, abi, functionName, args, expectSuccess = true) {
  const hash = await wallet(account).writeContract({ address, abi, functionName, args, gas: 1_500_000n });
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 60_000 });
  assert.equal(receipt.status, expectSuccess ? 'success' : 'reverted', `${functionName}: unexpected receipt status`);
  const transfers = [];
  const events = [];
  for (const log of receipt.logs) {
    try {
      if (log.address.toLowerCase() === A.usdc.toLowerCase()) {
        const event = decodeEventLog({ abi: tokenAbi, data: log.data, topics: log.topics });
        if (event.eventName === 'Transfer') transfers.push({ ...event.args, usdc: formatUnits(event.args.value, 6) });
      } else if (log.address.toLowerCase() === A.escrow.toLowerCase()) {
        const event = decodeEventLog({ abi: escrowAbi, data: log.data, topics: log.topics });
        events.push({ name: event.eventName, args: event.args });
      }
    } catch { /* Ignore USDC administration and non-payment logs. */ }
  }
  return { hash, status: receipt.status, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed, transfers, events };
}
async function withImpersonation(address, action) {
  await client.request({ method: 'anvil_setBalance', params: [address, '0x8ac7230489e80000'] });
  await client.request({ method: 'anvil_impersonateAccount', params: [address] });
  try { return await action(); }
  finally { await client.request({ method: 'anvil_stopImpersonatingAccount', params: [address] }); }
}
async function state(info) {
  const hash = await readEscrow('getHash', [info]);
  const [hasCollected, capturable, refundable] = await readEscrow('paymentState', [hash]);
  const balances = {};
  for (const [name, address] of Object.entries({ ...addresses, tokenStore, erc3009Collector: A.erc3009 })) balances[name] = await readToken('balanceOf', [address]);
  const code = await client.getCode({ address: tokenStore });
  return { hash, hasCollected, capturable, refundable, balances, tokenStoreDeployed: Boolean(code && code !== '0x') };
}
function check(actual, expected, label) { assert.deepEqual(actual, expected, label); }
function balancesDelta(before, after, expected) {
  for (const name of Object.keys(before.balances)) check(after.balances[name] - before.balances[name], expected[name] || 0n, `${name} balance delta`);
}
async function step(label, info, functionName, args, expectedState, expectedDeltas, account = actors.operator) {
  const before = await state(info);
  const transaction = await transact(account, A.escrow, escrowAbi, functionName, args);
  const after = await state(info);
  check([after.hasCollected, after.capturable, after.refundable], expectedState, label);
  balancesDelta(before, after, expectedDeltas);
  const item = { label, operation: functionName, paymentInfo: info, before, after, transaction };
  if (functionName === 'capture') {
    item.callTrace = await client.request({ method: 'debug_traceTransaction', params: [transaction.hash, { tracer: 'callTracer' }] });
    check(transaction.transfers.length, 2, 'capture must emit two USDC transfers');
    check(transaction.transfers[0].from.toLowerCase(), tokenStore.toLowerCase(), 'fee paid from TokenStore');
    check(transaction.transfers[1].from.toLowerCase(), tokenStore.toLowerCase(), 'merchant paid from TokenStore');
  }
  report.steps.push(item);
  console.log(`${label.padEnd(29)} capturable=${formatUnits(after.capturable, 6)} refundable=${formatUnits(after.refundable, 6)} | ${transaction.hash}`);
  return item;
}
async function expectRevert(label, info, functionName, args, expectedError, account = actors.operator) {
  const before = await state(info);
  let matched;
  try { await client.simulateContract({ address: A.escrow, abi: escrowAbi, functionName, args, account }); }
  catch (error) {
    const decoded = error.walk?.(cause => cause?.data?.errorName);
    const name = decoded?.data?.errorName;
    const observed = name === 'Error' ? `Error: ${decoded.data.args[0]}` : name;
    if (observed !== expectedError) throw error;
    matched = observed;
  }
  assert.equal(matched, expectedError, `${label}: expected revert was not observed`);
  check(await state(info), before, `${label}: unchanged state`);
  report.negativeChecks.push({ label, method: 'eth_call', expectedError, observedError: matched, stateUnchanged: true });
  console.log(`  PASS ${label}: ${matched}`);
}
function localHash(info) {
  const fields = [
    'address', 'address', 'address', 'address', 'uint120', 'uint48', 'uint48', 'uint48', 'uint16', 'uint16', 'address', 'uint256',
  ].map(type => ({ type }));
  const typehash = keccak256(stringToHex('PaymentInfo(address operator,address payer,address receiver,address token,uint120 maxAmount,uint48 preApprovalExpiry,uint48 authorizationExpiry,uint48 refundExpiry,uint16 minFeeBps,uint16 maxFeeBps,address feeReceiver,uint256 salt)'));
  const inner = keccak256(encodeAbiParameters([{ type: 'bytes32' }, ...fields], [typehash, ...Object.values(info)]));
  return keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }, { type: 'bytes32' }], [BigInt(CHAIN_ID), A.escrow, inner]));
}
async function signature(info) {
  check(localHash(info), await readEscrow('getHash', [info]), 'SDK-style hash matches deployed Escrow');
  const nonce = localHash({ ...info, payer: zeroAddress });
  check(nonce, await readEscrow('getHash', [{ ...info, payer: zeroAddress }]), 'payer-agnostic nonce matches');
  return actors.payer.signTypedData({ domain: { name: await readToken('name'), version: await readToken('version'), chainId: CHAIN_ID, verifyingContract: A.usdc }, types: receiveTypes, primaryType: 'ReceiveWithAuthorization', message: { from: actors.payer.address, to: A.erc3009, value: info.maxAmount, validAfter: 0n, validBefore: BigInt(info.preApprovalExpiry), nonce } });
}
try {
  for (const name of ['operator', 'payer']) await client.request({ method: 'anvil_setBalance', params: [addresses[name], '0x8ac7230489e80000'] });
  const masterMinter = await readToken('masterMinter');
  report.setup.push(await withImpersonation(masterMinter, () => transact(masterMinter, A.usdc, tokenAbi, 'configureMinter', [addresses.operator, 120_000_000n])));
  report.setup.push(await transact(actors.operator, A.usdc, tokenAbi, 'mint', [addresses.payer, 100_000_000n]));
  report.setup.push(await transact(actors.operator, A.usdc, tokenAbi, 'mint', [addresses.operator, 20_000_000n]));
  tokenStore = await readEscrow('getTokenStore', [addresses.operator]);
  report.tokenStore = tokenStore;
  const block = await client.getBlock();
  const makeInfo = salt => ({ operator: addresses.operator, payer: addresses.payer, receiver: addresses.merchant, token: A.usdc, maxAmount: 10_000_000n, preApprovalExpiry: Number(block.timestamp + 3600n), authorizationExpiry: Number(block.timestamp + 7200n), refundExpiry: Number(block.timestamp + 10800n), minFeeBps: 100, maxFeeBps: 100, feeReceiver: addresses.fee, salt });
  const a = makeInfo(1n), b = makeInfo(2n), c = makeInfo(3n);
  const signA = await signature(a), signB = await signature(b), signC = await signature(c);
  await expectRevert('capture without authorize', a, 'capture', [a, 6_000_000n, 60_000n, addresses.fee], 'InsufficientAuthorization');
  await expectRevert('changed receiver invalidates nonce', { ...a, receiver: addresses.fee }, 'authorize', [{ ...a, receiver: addresses.fee }, 10_000_000n, A.erc3009, signA], 'Error: FiatTokenV2: invalid signature');
  const authorized = await step('A authorize 10', a, 'authorize', [a, 10_000_000n, A.erc3009, signA], [true, 10_000_000n, 0n], { payer: -10_000_000n, tokenStore: 10_000_000n });
  check(authorized.after.tokenStoreDeployed, false, 'funding precedes clone deployment');
  await expectRevert('authorize cannot repeat', a, 'authorize', [a, 10_000_000n, A.erc3009, signA], 'PaymentAlreadyCollected');
  await expectRevert('payer cannot capture', a, 'capture', [a, 6_000_000n, 60_000n, addresses.fee], 'InvalidSender', actors.payer);
  await expectRevert('fee exceeds signed range', a, 'capture', [a, 6_000_000n, 100_000n, addresses.fee], 'FeeAmountOutOfRange');
  await expectRevert('zero capture', a, 'capture', [a, 0n, 0n, addresses.fee], 'ZeroAmount');
  await expectRevert('nothing refundable before capture', a, 'refund', [a, 1_000_000n, A.refundCollector, '0x'], 'RefundExceedsCapture');

  const blacklister = await readToken('blacklister');
  report.setup.push(await withImpersonation(blacklister, () => transact(blacklister, A.usdc, tokenAbi, 'blacklist', [addresses.merchant])));
  const rollbackBefore = await state(a);
  const failedCapture = await transact(actors.operator, A.escrow, escrowAbi, 'capture', [a, 6_000_000n, 60_000n, addresses.fee], false);
  const failedTrace = await client.request({ method: 'debug_traceTransaction', params: [failedCapture.hash, { tracer: 'callTracer' }] });
  check(await state(a), rollbackBefore, 'merchant failure rolls back fee, ledger, and clone creation');
  check(failedCapture.transfers.length, 0, 'reverted transfer logs absent');
  report.negativeChecks.push({ label: 'merchant transfer fails after fee transfer; entire capture rolls back', method: 'local transaction', stateUnchanged: true, transaction: failedCapture, callTrace: failedTrace });
  console.log('  PASS merchant failure: fee, ledger and clone deployment rolled back');
  report.setup.push(await withImpersonation(blacklister, () => transact(blacklister, A.usdc, tokenAbi, 'unBlacklist', [addresses.merchant])));

  const captured = await step('A capture 6 / fee 0.06', a, 'capture', [a, 6_000_000n, 60_000n, addresses.fee], [true, 4_000_000n, 6_000_000n], { merchant: 5_940_000n, fee: 60_000n, tokenStore: -6_000_000n });
  check(captured.after.tokenStoreDeployed, true, 'first successful outgoing payment deploys clone');
  await expectRevert('capture exceeds remaining 4', a, 'capture', [a, 5_000_000n, 50_000n, addresses.fee], 'InsufficientAuthorization');
  await step('A void remaining 4', a, 'void', [a], [true, 0n, 6_000_000n], { payer: 4_000_000n, tokenStore: -4_000_000n });
  await expectRevert('refund requires operator allowance', a, 'refund', [a, 2_000_000n, A.refundCollector, '0x'], 'Error: ERC20: transfer amount exceeds allowance');
  report.setup.push(await transact(actors.operator, A.usdc, tokenAbi, 'approve', [A.refundCollector, 12_000_000n]));
  await step('A refund 2', a, 'refund', [a, 2_000_000n, A.refundCollector, '0x'], [true, 0n, 4_000_000n], { operator: -2_000_000n, payer: 2_000_000n });
  await step('A refund remaining 4', a, 'refund', [a, 4_000_000n, A.refundCollector, '0x'], [true, 0n, 0n], { operator: -4_000_000n, payer: 4_000_000n });
  await expectRevert('refund exceeds remaining quota', a, 'refund', [a, 1n, A.refundCollector, '0x'], 'RefundExceedsCapture');
  await expectRevert('fully refunded payment stays used', a, 'authorize', [a, 10_000_000n, A.erc3009, signA], 'PaymentAlreadyCollected');

  const charged = await step('B charge 6 / cap 10', b, 'charge', [b, 6_000_000n, A.erc3009, signB, 60_000n, addresses.fee], [true, 0n, 6_000_000n], { payer: -6_000_000n, merchant: 5_940_000n, fee: 60_000n });
  check(charged.transaction.transfers.map(x => x.value), [10_000_000n, 4_000_000n, 6_000_000n, 60_000n, 5_940_000n], 'ERC3009 charge pulls cap, returns excess, then splits actual amount');
  await expectRevert('charge has no voidable balance', b, 'void', [b], 'ZeroAuthorization');
  await step('B refund 6', b, 'refund', [b, 6_000_000n, A.refundCollector, '0x'], [true, 0n, 0n], { operator: -6_000_000n, payer: 6_000_000n });

  await step('C authorize 10', c, 'authorize', [c, 10_000_000n, A.erc3009, signC], [true, 10_000_000n, 0n], { payer: -10_000_000n, tokenStore: 10_000_000n });
  await expectRevert('reclaim before expiry', c, 'reclaim', [c], 'BeforeAuthorizationExpiry', actors.payer);
  await client.request({ method: 'evm_setNextBlockTimestamp', params: [c.authorizationExpiry] });
  await client.request({ method: 'evm_mine' });
  await expectRevert('capture at expiry', c, 'capture', [c, 6_000_000n, 60_000n, addresses.fee], 'AfterAuthorizationExpiry');
  await step('C payer reclaim 10', c, 'reclaim', [c], [true, 0n, 0n], { payer: 10_000_000n, tokenStore: -10_000_000n }, actors.payer);
  check(await readToken('balanceOf', [addresses.payer]), 100_000_000n, 'payer restored after both refunds and reclaim');
  report.success = true;
  await mkdir(new URL('./results/', import.meta.url), { recursive: true });
  await writeFile(new URL('./results/demo.json', import.meta.url), json(report) + '\n');
  console.log(`PASS: ${report.steps.length} successful lifecycle transactions; ${report.negativeChecks.length} rejection/rollback checks. Public transactions sent: 0.`);
} finally {
  assert.equal(await client.request({ method: 'evm_revert', params: [snapshot] }), true, 'Restore local fork snapshot');
}
