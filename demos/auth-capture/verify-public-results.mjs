import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createPublicClient, http, decodeFunctionData, decodeEventLog } from 'viem';
import { ADDRESSES as A, CHAIN_ID, escrowAbi, tokenAbi, json } from './contracts.mjs';

const result = JSON.parse(await readFile(new URL('./results/public-demo.json', import.meta.url), 'utf8'));
assert.equal(result.complete, true, 'Finish the public demonstration first');
const clients = ['https://sepolia.base.org', 'https://base-sepolia-rpc.publicnode.com'].map(url => createPublicClient({ transport: http(url, { timeout: 30_000 }) }));
for (const client of clients) assert.equal(await client.getChainId(), CHAIN_ID);
const [pc, other] = clients;
const block = await pc.getBlock();
assert.equal((await other.getBlock({ blockNumber: block.number })).hash, block.hash, 'Independent RPC block mismatch');
const audit = { generatedAt: new Date().toISOString(), chainId: CHAIN_ID, blockNumber: block.number, blockHash: block.hash,
  rpcProviders: ['sepolia.base.org', 'base-sepolia-rpc.publicnode.com'], lifecycleReceipts: [], setupReceipts: [], payments: [], balanceDeltasFromTransferLogs: {}, success: false };
const actorByAddress = Object.fromEntries(Object.entries({ ...result.actors, tokenStore: result.tokenStore, erc3009: A.erc3009, permit2Collector: A.permit2Collector }).map(([k, v]) => [v.toLowerCase(), k]));
const delta = Object.fromEntries(Object.keys(result.balanceDeltas).map(k => [k, 0n]));
for (const transaction of result.transactions) {
  const [r, r2, tx] = await Promise.all([pc.getTransactionReceipt({ hash: transaction.hash }), other.getTransactionReceipt({ hash: transaction.hash }), pc.getTransaction({ hash: transaction.hash })]);
  assert.equal(r.status, 'success'); assert.equal(r2.status, 'success');
  assert.equal(r.blockHash, r2.blockHash);
  assert.ok(!/^0x0{64}$/.test(r.blockHash), 'Require a canonical receipt');
  if (/^0x0{64}$/.test(transaction.blockHash)) {
    transaction.preconfirmationBlockHash = transaction.blockHash;
    transaction.blockHash = r.blockHash;
  } else assert.equal(r.blockHash, transaction.blockHash);
  assert.equal(tx.chainId, CHAIN_ID); assert.equal(tx.to.toLowerCase(), A.escrow.toLowerCase());
  const call = decodeFunctionData({ abi: escrowAbi, data: tx.input });
  assert.equal(tx.from.toLowerCase(), result.actors[call.functionName === 'reclaim' ? 'payer' : 'operator'].toLowerCase());
  const transfers = r.logs.filter(log => log.address.toLowerCase() === A.usdc.toLowerCase()).flatMap(log => {
    try { const e = decodeEventLog({ abi: tokenAbi, ...log }); return e.eventName === 'Transfer' ? [e.args] : []; } catch { return []; }
  });
  assert.deepEqual(transfers.map(x => String(x.value)), transaction.transfers.map(x => x.value));
  for (const transfer of transfers) {
    for (const [address, change] of [[transfer.from, -transfer.value], [transfer.to, transfer.value]]) {
      const actor = actorByAddress[address.toLowerCase()]; if (actor in delta) delta[actor] += change;
    }
  }
  if (call.functionName === 'capture') assert.deepEqual(transfers.map(x => x.value), [60n, 5940n]);
  if (call.functionName === 'charge') {
    const via3009 = call.args[2].toLowerCase() === A.erc3009.toLowerCase();
    assert.deepEqual(transfers.map(x => x.value), via3009 ? [10000n, 4000n, 6000n, 60n, 5940n] : [6000n, 60n, 5940n]);
  }
  if (call.functionName === 'refund') {
    assert.equal(transfers.length, 2);
    assert.equal(transfers[0].from.toLowerCase(), result.actors.operator.toLowerCase());
    assert.equal(transfers[1].to.toLowerCase(), result.actors.payer.toLowerCase());
  }
  audit.lifecycleReceipts.push({ hash: transaction.hash, functionName: call.functionName, bothRpcStatus: 'success', blockHash: r.blockHash, transferCount: transfers.length });
}
const fundingUrl = new URL('./results/public-funding.json', import.meta.url);
const funding = JSON.parse(await readFile(fundingUrl, 'utf8'));
for (const transaction of [...funding.transactions, ...result.setup]) {
  const [r, r2] = await Promise.all([pc.getTransactionReceipt({ hash: transaction.hash }), other.getTransactionReceipt({ hash: transaction.hash })]);
  assert.equal(r.status, 'success'); assert.equal(r2.status, 'success'); assert.equal(r.blockHash, r2.blockHash);
  assert.ok(!/^0x0{64}$/.test(r.blockHash));
  if (/^0x0{64}$/.test(transaction.blockHash)) transaction.preconfirmationBlockHash = transaction.blockHash;
  else assert.equal(transaction.blockHash, r.blockHash);
  transaction.blockHash = r.blockHash;
  audit.setupReceipts.push({ hash: transaction.hash, label: transaction.label, bothRpcStatus: 'success', blockHash: r.blockHash });
}
for (const [actor, expected] of Object.entries(result.balanceDeltas)) assert.equal(delta[actor], BigInt(expected), `${actor} transfer conservation`);
audit.balanceDeltasFromTransferLogs = delta;
for (const payment of result.payments) {
  const state = await pc.readContract({ address: A.escrow, abi: escrowAbi, functionName: 'paymentState', args: [payment.paymentInfoHash], blockNumber: block.number });
  assert.deepEqual(state, [true, 0n, 0n]);
  audit.payments.push({ path: payment.path, paymentInfoHash: payment.paymentInfoHash, finalState: state });
}
const allowance = (owner, spender) => pc.readContract({ address: A.usdc, abi: tokenAbi, functionName: 'allowance', args: [owner, spender], blockNumber: block.number });
assert.equal(await allowance(result.actors.payer, result.contracts.permit2), 0n);
assert.equal(await allowance(result.actors.operator, A.refundCollector), 0n);
for (const address of [result.tokenStore, A.erc3009, A.permit2Collector]) assert.equal(await pc.readContract({ address: A.usdc, abi: tokenAbi, functionName: 'balanceOf', args: [address], blockNumber: block.number }), 0n);
audit.allowancesRevoked = true; audit.escrowAndCollectorBalancesZero = true;
audit.knownSdkIssues = result.issues.map(x => x.id);
audit.success = true;
result.finalEth = { payer: await pc.getBalance({ address: result.actors.payer, blockNumber: block.number }), operator: await pc.getBalance({ address: result.actors.operator, blockNumber: block.number }) };
await writeFile(new URL('./results/public-demo.json', import.meta.url), `${json(result)}\n`);
await writeFile(fundingUrl, `${json(funding)}\n`);
await writeFile(new URL('./results/public-audit.json', import.meta.url), `${json(audit)}\n`);
console.log(`Verified ${audit.lifecycleReceipts.length} lifecycle + ${audit.setupReceipts.length} setup receipts on two independent RPCs, ${audit.payments.length} final states, token conservation and allowance revocation. SDK issues: ${audit.knownSdkIssues.length}.`);
