import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPublicClient, createWalletClient, http, publicActions, parseAbi, parseAbiItem, decodeEventLog, formatUnits, getAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { ADDRESSES as A, CHAIN_ID, SOURCE_COMMIT, escrowAbi, tokenAbi, json } from './contracts.mjs';

// This runner sends small, real Base Sepolia transactions. The fork runner stays separate.
assert.equal(process.env.PUBLIC_BASE_SEPOLIA_DEMO, '1', 'Set PUBLIC_BASE_SEPOLIA_DEMO=1 to broadcast testnet transactions');
assert.ok(process.env.DEMO_WALLET_MODULE, 'DEMO_WALLET_MODULE must export loadAccounts()');
assert.ok(process.env.X402_SDK_DIR, 'X402_SDK_DIR must point to the pinned, built x402 checkout');
const sdk = resolve(process.env.X402_SDK_DIR);
const sdkCommit = 'faa1c694c66a3732aaabbce93bdae140e521a67d';
assert.equal(execFileSync('git', ['-C', sdk, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sdkCommit);
assert.equal(execFileSync('git', ['-C', sdk, 'diff', '--name-only', 'HEAD', '--', 'typescript/packages'], { encoding: 'utf8' }).trim(), '', 'Do not change SDK source for this demonstration');
const moduleAt = path => import(pathToFileURL(`${sdk}/typescript/packages/${path}/dist/esm/index.mjs`));
const [{ x402Facilitator }, { HTTPFacilitatorClient }, { x402Client }, { toFacilitatorEvmSigner },
  { AuthCaptureEvmScheme: FacilitatorScheme }, { AuthCaptureEvmScheme: ServerScheme },
  { AuthCaptureEvmScheme: ClientScheme }, expressSdk, { wrapFetchWithPayment }] = await Promise.all([
  import(pathToFileURL(`${sdk}/typescript/packages/core/dist/esm/facilitator/index.mjs`)),
  import(pathToFileURL(`${sdk}/typescript/packages/core/dist/esm/server/index.mjs`)),
  import(pathToFileURL(`${sdk}/typescript/packages/core/dist/esm/client/index.mjs`)),
  moduleAt('mechanisms/evm'),
  import(pathToFileURL(`${sdk}/typescript/packages/mechanisms/evm/dist/esm/auth-capture/facilitator/index.mjs`)),
  import(pathToFileURL(`${sdk}/typescript/packages/mechanisms/evm/dist/esm/auth-capture/server/index.mjs`)),
  import(pathToFileURL(`${sdk}/typescript/packages/mechanisms/evm/dist/esm/auth-capture/client/index.mjs`)),
  moduleAt('http/express'), moduleAt('http/fetch'),
]);
const express = createRequire(`${sdk}/typescript/packages/http/express/package.json`)('express');
const { x402ResourceServer, x402HTTPResourceServer, paymentMiddlewareFromHTTPServer, setSettlementOverrides } = expressSdk;
const { loadAccounts } = await import(pathToFileURL(resolve(process.env.DEMO_WALLET_MODULE)));
// Wallet modules keep secret retrieval outside the published demo. Never serialize accounts.
const { payer, operator, merchant: merchantInput, fee: feeInput } = await loadAccounts();
const merchant = getAddress(merchantInput), fee = getAddress(feeInput);
assert.equal(new Set([payer.address, operator.address, merchant, fee].map(x => x.toLowerCase())).size, 4, 'Use four distinct public addresses');
const authorizer = privateKeyToAccount(generatePrivateKey());
const rpc = process.env.BASE_SEPOLIA_RPC || 'https://sepolia.base.org';
assert.equal(new URL(rpc).protocol, 'https:', 'Use a public HTTPS testnet RPC');
const transport = http(rpc, { timeout: 30_000 });
const pc = createPublicClient({ chain: baseSepolia, transport });
assert.equal(await pc.getChainId(), CHAIN_ID, 'Only Base Sepolia is permitted');
assert.ok(!/anvil|hardhat/i.test(await pc.request({ method: 'web3_clientVersion' })), 'Use the public network');
const wallet = account => createWalletClient({ account, chain: baseSepolia, transport }).extend(publicActions);
const payerWallet = wallet(payer), operatorWallet = wallet(operator);
const permit2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const readToken = (functionName, args) => pc.readContract({ address: A.usdc, abi: tokenAbi, functionName, args });
const readEscrow = (functionName, args) => pc.readContract({ address: A.escrow, abi: escrowAbi, functionName, args });
const tokenStore = await readEscrow('getTokenStore', [operator.address]);
const output = resolve(process.env.PUBLIC_DEMO_RESULTS || 'results/public-demo.json');
const freshReport = { mode: 'public-base-sepolia', generatedAt: new Date().toISOString(), chainId: CHAIN_ID, sdkCommit,
  sourceCommit: SOURCE_COMMIT, rpc, contracts: { ...A, permit2 }, actors: { payer: payer.address, operator: operator.address, merchant, fee, receiverAuthorizer: authorizer.address },
  tokenStore, unit: 'USDC base units (6 decimals)', maxPayment: '10000', actualPayment: '6000', feeBps: 100,
  setup: [], transactions: [], requests: [], checks: [], payments: [], issues: [], complete: false };
let previous;
try { previous = JSON.parse(await readFile(output, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (previous) {
  assert.equal(process.env.PUBLIC_DEMO_RESUME, '1', 'A result already exists. Use a different PUBLIC_DEMO_RESULTS, or PUBLIC_DEMO_RESUME=1 after reviewing it');
  assert.equal(previous.complete, false, 'Do not overwrite a completed public run');
  assert.equal(previous.sdkCommit, sdkCommit); assert.equal(previous.chainId, CHAIN_ID);
  for (const name of ['payer', 'operator', 'merchant', 'fee']) assert.equal(previous.actors[name], freshReport.actors[name]);
}
const report = previous ?? freshReport;
report.issues ??= [];
report.receiverAuthorizers = [...new Set([...(report.receiverAuthorizers ?? [report.actors.receiverAuthorizer]), authorizer.address])];
await mkdir(resolve(output, '..'), { recursive: true });
const save = () => writeFile(output, `${json(report)}\n`);
const actors = { payer: payer.address, operator: operator.address, merchant, fee, tokenStore, erc3009: A.erc3009, permit2Collector: A.permit2Collector };
async function balances() { return Object.fromEntries(await Promise.all(Object.entries(actors).map(async ([k, v]) => [k, await readToken('balanceOf', [v])]))); }
async function paymentState(hash) { const [hasCollected, capturable, refundable] = await readEscrow('paymentState', [hash]); return { hasCollected, capturable, refundable }; }
async function receipt(hash, label) {
  let raw = await pc.waitForTransactionReceipt({ hash, confirmations: 2, timeout: 120_000 });
  // Base RPC can initially return a Flashblocks receipt whose blockHash is zero.
  // Persist a canonical L2 block receipt, rather than treating that preconfirmation as final.
  const receiptDeadline = Date.now() + 120_000;
  while (/^0x0{64}$/.test(raw.blockHash)) {
    assert.ok(Date.now() < receiptDeadline, 'Canonical receipt not available yet');
    await new Promise(r => setTimeout(r, 2_000));
    raw = await pc.getTransactionReceipt({ hash });
  }
  assert.equal((await pc.getBlock({ blockNumber: raw.blockNumber })).hash, raw.blockHash);
  assert.equal(raw.status, 'success', `${label} receipt reverted`);
  const tx = await pc.getTransaction({ hash });
  assert.equal(tx.chainId, CHAIN_ID);
  const transfers = [], events = [];
  for (const log of raw.logs) {
    try {
      if (log.address.toLowerCase() === A.usdc.toLowerCase()) {
        const e = decodeEventLog({ abi: tokenAbi, ...log });
        if (e.eventName === 'Transfer') transfers.push({ ...e.args, usdc: formatUnits(e.args.value, 6) });
      } else if (log.address.toLowerCase() === A.escrow.toLowerCase()) {
        const e = decodeEventLog({ abi: escrowAbi, ...log });
        events.push({ name: e.eventName, args: e.args });
      }
    } catch { /* Only payment and token events are relevant here. */ }
  }
  const result = { label, hash, explorer: `https://sepolia.basescan.org/tx/${hash}`, status: raw.status,
    blockNumber: raw.blockNumber, blockHash: raw.blockHash, from: tx.from, to: tx.to,
    gasUsed: raw.gasUsed, effectiveGasPrice: raw.effectiveGasPrice, l1Fee: raw.l1Fee,
    transfers, events };
  return result;
}
let writes = 0;
const maxFeePerGas = 20_000_000n; // 0.02 gwei; testnet only, bounded fee and gas on every write.
function bounded(args) {
  assert.ok(++writes <= 40, 'Transaction budget exceeded');
  return { ...args, gas: 1_000_000n, maxFeePerGas, maxPriorityFeePerGas: 1_000_000n };
}
async function setupTx(hash, label) {
  const item = await receipt(hash, label); report.setup.push(item); await save();
  console.log(`${label}: ${hash}`);
}
async function record(hash, label) {
  if (report.transactions.some(x => x.hash === hash)) return;
  const item = await receipt(hash, label); report.transactions.push(item); await save();
  console.log(`${label}: ${hash}`);
}
const startBalances = await balances();
report.initialBalances ??= startBalances;
report.initialEth ??= { payer: await pc.getBalance({ address: payer.address }), operator: await pc.getBalance({ address: operator.address }) };
assert.ok(report.initialEth.payer >= 200_000_000_000_000n, 'Payer needs at least 0.0002 test ETH');
assert.ok(startBalances.payer >= 100_000n, 'Payer needs at least 0.1 test USDC');
assert.equal(startBalances.tokenStore, 0n, 'Use an operator without outstanding escrow funds');
for (const address of Object.values(A)) assert.ok((await pc.getCode({ address }))?.length > 2, `Missing public deployment ${address}`);
await save();

// Fund only the two known test accounts, with finite amounts and approvals.
if (!previous && report.initialEth.operator < 80_000_000_000_000n) {
  await setupTx(await payerWallet.sendTransaction(bounded({ to: operator.address, value: 100_000_000_000_000n })), 'fund operator 0.0001 test ETH');
}
const transferAbi = parseAbi(['function transfer(address to,uint256 amount) returns(bool)']);
if (!previous && startBalances.operator < 40_000n) {
  await setupTx(await payerWallet.writeContract(bounded({ address: A.usdc, abi: transferAbi, functionName: 'transfer', args: [operator.address, 50_000n] })), 'fund operator 0.05 test USDC for refunds');
}
if (!previous) {
  await setupTx(await operatorWallet.writeContract(bounded({ address: A.usdc, abi: tokenAbi, functionName: 'approve', args: [A.refundCollector, 50_000n] })), 'approve refund collector 0.05 USDC');
  await setupTx(await payerWallet.writeContract(bounded({ address: A.usdc, abi: tokenAbi, functionName: 'approve', args: [permit2, 20_000n] })), 'approve Permit2 0.02 USDC');
  report.baselineBalances = await balances();
}
const signer = toFacilitatorEvmSigner({
  address: operator.address,
  getCode: args => pc.getCode(args), readContract: args => pc.readContract({ ...args, args: args.args ?? [] }),
  simulateCalls: args => pc.simulateCalls(args), verifyTypedData: args => pc.verifyTypedData(args),
  writeContract: async args => {
    assert.equal(args.address.toLowerCase(), A.escrow.toLowerCase(), 'SDK may only call canonical escrow');
    return operatorWallet.writeContract(bounded(args));
  },
  sendTransaction: async args => {
    assert.equal(args.to?.toLowerCase(), A.escrow.toLowerCase(), 'SDK may only call canonical escrow');
    return operatorWallet.sendTransaction(bounded(args));
  },
  waitForTransactionReceipt: args => pc.waitForTransactionReceipt({ ...args, confirmations: 2, timeout: 120_000 }),
});
const facilitator = new x402Facilitator().register('eip155:84532', new FacilitatorScheme(signer, {
  refundFunding: true, feeTerms: { feeRecipient: fee, minFeeBps: 100, maxFeeBps: 100 },
}));
const listen = app => new Promise(resolveListen => { const s = app.listen(0, '127.0.0.1', () => resolveListen(s)); });
const base = s => `http://127.0.0.1:${s.address().port}`;
const fa = express(); fa.use(express.json({ limit: '128kb' }));
fa.get('/supported', (_req, res) => res.json(facilitator.getSupported()));
for (const operation of ['verify', 'settle']) fa.post(`/${operation}`, async (req, res) => {
  try {
    const { paymentPayload, paymentRequirements } = req.body;
    const result = await facilitator[operation](paymentPayload, paymentRequirements);
    report.requests.push({ side: 'facilitator', operation, type: paymentPayload.payload.type ?? 'collect', flow: paymentRequirements.extra.paymentFlow,
      assetTransferMethod: paymentRequirements.extra.assetTransferMethod, result });
    if (result.success && result.transaction) await record(result.transaction, `${operation} ${paymentPayload.payload.type ?? paymentRequirements.extra.paymentFlow}`);
    await save(); res.json(result);
  } catch (error) { report.requests.push({ side: 'facilitator', operation, error: error.shortMessage ?? error.name }); await save(); res.status(500).json({ error: 'Demo facilitator failed; inspect local results' }); }
});
const fs = await listen(fa);
const facilitatorClient = new HTTPFacilitatorClient({ url: base(fs) });
const serverScheme = new ServerScheme({ receiverAuthorizerSigner: authorizer });
const lifecycle = serverScheme.createLifecycleManager(facilitatorClient);
const rs = new x402ResourceServer(facilitatorClient).register('eip155:84532', serverScheme);
const route = (paymentFlow, assetTransferMethod = 'eip3009', captureMode = 'deferred', seconds = 1200) => ({
  accepts: { scheme: 'auth-capture', network: 'eip155:84532', price: { amount: '10000', asset: A.usdc, extra: { name: 'USDC', version: '2' } },
    payTo: merchant, maxTimeoutSeconds: 60,
    extra: { feeRecipient: fee, minFeeBps: 100, maxFeeBps: 100, captureDeadlineSeconds: seconds, refundDeadlineSeconds: 3600,
      operatorType: 'delegated', paymentFlow, assetTransferMethod, ...(paymentFlow === 'escrow' ? { captureMode } : {}) } },
  description: 'Base Sepolia auth-capture verification', mimeType: 'application/json',
});
const routes = {
  'GET /erc3009/deferred': route('escrow'), 'GET /erc3009/charge': route('authorization'),
  'GET /permit2/deferred': route('escrow', 'permit2'), 'GET /permit2/charge': route('authorization', 'permit2'),
  'GET /erc3009/sync': route('escrow', 'eip3009', 'sync'),
  'GET /erc3009/reclaim': route('escrow', 'eip3009', 'deferred', 180),
};
const hs = new x402HTTPResourceServer(rs, routes); await hs.initialize();
const app = express(); app.use(paymentMiddlewareFromHTTPServer(hs, undefined, undefined, false));
const handlerCalls = new Map();
for (const key of Object.keys(routes)) {
  const path = key.slice(4);
  app.get(path, (_req, res) => {
    handlerCalls.set(path, (handlerCalls.get(path) ?? 0) + 1);
    if (path.endsWith('/charge') || path.endsWith('/sync')) setSettlementOverrides(res, { amount: '60%' });
    res.json({ resource: path, actualUsdc: '0.006' });
  });
}
const ss = await listen(app);
const client = new x402Client().register('eip155:84532', new ClientScheme(payer));
const observedFetch = async (...args) => {
  const request = new Request(...args);
  const paid = request.headers.has('PAYMENT-SIGNATURE');
  const response = await fetch(request);
  const required = response.headers.get('PAYMENT-REQUIRED');
  const settlement = response.headers.get('PAYMENT-RESPONSE');
  report.requests.push({ side: 'resource', path: new URL(request.url).pathname, signedRequest: paid, status: response.status,
    ...(required ? { paymentRequired: JSON.parse(Buffer.from(required, 'base64').toString()) } : {}),
    ...(settlement ? { settlement: JSON.parse(Buffer.from(settlement, 'base64').toString()) } : {}) });
  await save(); return response;
};
const paidFetch = wrapFetchWithPayment(observedFetch, client);
async function request(path) {
  const before = new Set((await lifecycle.listAuthorizedPayments()).map(x => x.paymentInfoHash));
  const response = await paidFetch(`${base(ss)}${path}`);
  assert.equal(response.status, 200, `Payment failed at ${path}`);
  assert.equal((await response.json()).resource, path);
  assert.equal(handlerCalls.get(path), 1, 'Resource handler must run once, after successful payment gating');
  const calls = report.requests.filter(x => x.side === 'resource' && x.path === path);
  assert.deepEqual(calls.map(x => [x.signedRequest, x.status]), [[false, 402], [true, 200]], 'Real 402 → signature → 200 exchange');
  const payment = (await lifecycle.listAuthorizedPayments()).find(x => !before.has(x.paymentInfoHash));
  assert.ok(payment, 'SDK must persist authorized payment');
  report.payments.push({ path, ...payment }); await save(); return payment;
}
async function expectState(payment, capturable, refundable) {
  const actual = await paymentState(payment.paymentInfoHash);
  assert.deepEqual(actual, { hasCollected: true, capturable, refundable });
  report.checks.push({ paymentInfoHash: payment.paymentInfoHash, expectedState: actual, passed: true }); await save();
}
async function lifecycleCall(payment, method, opts) {
  const result = await lifecycle[method](payment.paymentInfoHash, opts);
  assert.equal(result.success, true, `${method}: ${result.errorReason}`);
  await record(result.transaction, method); return result;
}
async function negative(label, payment, functionName, args, account, expected) {
  const before = await paymentState(payment.paymentInfoHash);
  let observed;
  try { await pc.simulateContract({ address: A.escrow, abi: escrowAbi, functionName, args, account }); }
  catch (error) { const e = error.walk?.(x => x?.data?.errorName); observed = e?.data?.errorName; }
  assert.equal(observed, expected, label);
  assert.deepEqual(await paymentState(payment.paymentInfoHash), before);
  report.checks.push({ label, method: 'public RPC eth_call (no broadcast)', expectedError: expected, observedError: observed, stateUnchanged: true, passed: true }); await save();
}
try {
  for (const method of ['erc3009', 'permit2']) {
    const priorDeferred = report.payments.find(x => x.path === `/${method}/deferred`);
    const priorCharge = report.payments.find(x => x.path === `/${method}/charge`);
    if (previous && priorDeferred && priorCharge) {
      await expectState(priorDeferred, 0n, 0n); await expectState(priorCharge, 0n, 0n);
      continue;
    }
    const p = await request(`/${method}/deferred`);
    await expectState(p, 10000n, 0n);
    await negative(`${method}: payer cannot capture`, p, 'capture', [p.paymentInfo, 6000n, 60n, fee], payer.address, 'InvalidSender');
    await lifecycleCall(p, 'capture', { amount: '6000', feeAmount: '60' }); await expectState(p, 4000n, 6000n);
    await negative(`${method}: excessive capture`, p, 'capture', [p.paymentInfo, 5000n, 50n, fee], operator.address, 'InsufficientAuthorization');
    await lifecycleCall(p, 'voidPayment'); await expectState(p, 0n, 6000n);
    await lifecycleCall(p, 'refund', { amount: '2000' }); await expectState(p, 0n, 4000n);
    await lifecycleCall(p, 'refund', { amount: '4000' }); await expectState(p, 0n, 0n);
    await negative(`${method}: over-refund`, p, 'refund', [p.paymentInfo, 1n, A.refundCollector, '0x'], operator.address, 'RefundExceedsCapture');
    const c = await request(`/${method}/charge`); await expectState(c, 0n, 6000n);
    await negative(`${method}: charge has no void remainder`, c, 'void', [c.paymentInfo], operator.address, 'ZeroAuthorization');
    await lifecycleCall(c, 'refund', { amount: '6000' }); await expectState(c, 0n, 0n);
  }
  const sync = report.payments.find(x => x.path === '/erc3009/sync') ?? await request('/erc3009/sync');
  // Sync capture may also void the remainder in a trailing transaction; verify public state explicitly.
  const syncState = await paymentState(sync.paymentInfoHash);
  if (syncState.refundable > 0n) {
  assert.equal(syncState.refundable, 6000n);
  if (syncState.capturable > 0n) await lifecycleCall(sync, 'voidPayment');
  await expectState(sync, 0n, 6000n);
  // A partial sync capture can emit an additional void transaction inside the facilitator.
  const syncReceipt = await pc.getTransactionReceipt({ hash: sync.collectTransaction });
  const voidLogs = await pc.getLogs({ address: A.escrow, event: parseAbiItem('event PaymentVoided(bytes32 indexed paymentInfoHash,uint256 amount)'),
    args: { paymentInfoHash: sync.paymentInfoHash }, fromBlock: syncReceipt.blockNumber, toBlock: 'latest' });
  for (const log of voidLogs) await record(log.transactionHash, 'sync automatic void remainder');
  const priorRejectedRefund = report.requests.findLast(x => x.side === 'facilitator' && x.type === 'refund' && x.result?.errorReason === 'invalid_auth_capture_evm_unexpected_payment_state');
  const syncRefund = previous && priorRejectedRefund ? priorRejectedRefund.result : await lifecycle.refund(sync.paymentInfoHash, { amount: '6000' });
  if (syncRefund.success) {
    await record(syncRefund.transaction, 'sync refund');
  } else {
    assert.equal(syncRefund.errorReason, 'invalid_auth_capture_evm_unexpected_payment_state');
    const stored = previous ? sync : await lifecycle.getAuthorizedPayment(sync.paymentInfoHash);
    assert.equal(stored.capturableAmount, '10000'); assert.equal(stored.refundableAmount, '0');
    const issue = { id: 'sync-storage-after-settle', paymentInfoHash: sync.paymentInfoHash, sdkCommit,
      observedError: syncRefund.errorReason, stored: { capturableAmount: stored.capturableAmount, refundableAmount: stored.refundableAmount },
      onchain: await paymentState(sync.paymentInfoHash),
      cause: 'core sends the enriched settlePayload to facilitator but passes the original context.paymentPayload to afterSettle; the auth-capture hook therefore does not see type=capture and does not update stored balances.',
      recovery: 'Operator calls canonical Escrow.refund directly after checking the public chain state. This bypasses the stale SDK storage, not the contract permissions.' };
    report.issues.push(issue); await save();
    const hash = await operatorWallet.writeContract(bounded({ address: A.escrow, abi: escrowAbi, functionName: 'refund', args: [sync.paymentInfo, 6000n, A.refundCollector, '0x'] }));
    await record(hash, 'sync refund recovery: direct operator call'); issue.recoveryTransaction = hash;
  }
  }
  await expectState(sync, 0n, 0n);
  const reclaim = report.payments.find(x => x.path === '/erc3009/reclaim') ?? await request('/erc3009/reclaim');
  if ((await paymentState(reclaim.paymentInfoHash)).capturable > 0n) {
  await expectState(reclaim, 10000n, 0n);
  if ((await pc.getBlock()).timestamp < BigInt(reclaim.paymentInfo.authorizationExpiry)) await negative('payer reclaim before deadline', reclaim, 'reclaim', [reclaim.paymentInfo], payer.address, 'BeforeAuthorizationExpiry');
  console.log(`Waiting for public block timestamp > ${reclaim.paymentInfo.authorizationExpiry}; no local time travel.`);
  while ((await pc.getBlock()).timestamp <= BigInt(reclaim.paymentInfo.authorizationExpiry)) await new Promise(r => setTimeout(r, 5_000));
  await negative('operator cannot capture after deadline', reclaim, 'capture', [reclaim.paymentInfo, 6000n, 60n, fee], operator.address, 'AfterAuthorizationExpiry');
  const reclaimHash = await payerWallet.writeContract(bounded({ address: A.escrow, abi: escrowAbi, functionName: 'reclaim', args: [reclaim.paymentInfo] }));
  await record(reclaimHash, 'payer reclaim after public deadline');
  }
  await expectState(reclaim, 0n, 0n);
  report.finalBalances = await balances();
  const expectedDeltas = { payer: 0n, operator: -30000n, merchant: 29700n, fee: 300n, tokenStore: 0n, erc3009: 0n, permit2Collector: 0n };
  for (const [actor, delta] of Object.entries(expectedDeltas)) assert.equal(report.finalBalances[actor] - BigInt(report.baselineBalances[actor]), delta, `${actor} final token delta`);
  report.balanceDeltas = expectedDeltas;
  for (const operation of ['PaymentAuthorized', 'PaymentCaptured', 'PaymentCharged', 'PaymentVoided', 'PaymentRefunded', 'PaymentReclaimed']) assert.ok(report.transactions.some(x => x.events.some(e => e.name === operation)), `Missing ${operation}`);
  const captured = report.transactions.find(x => x.events.some(e => e.name === 'PaymentCaptured'));
  assert.deepEqual(captured.transfers.map(x => BigInt(x.value)), [60n, 5940n]);
  assert.ok(captured.transfers.every(x => x.from.toLowerCase() === tokenStore.toLowerCase()));
  report.finalEth = { payer: await pc.getBalance({ address: payer.address }), operator: await pc.getBalance({ address: operator.address }) };
  assert.ok(BigInt(report.initialEth.payer) + BigInt(report.initialEth.operator) - report.finalEth.payer - report.finalEth.operator < 500_000_000_000_000n, 'Test ETH budget exceeded');
  report.checks.push({ label: 'All six HTTP paths, six lifecycle events, split transfers and final token conservation', passed: true });
  // Revoke unused allowances after the demonstration.
  await setupTx(await payerWallet.writeContract(bounded({ address: A.usdc, abi: tokenAbi, functionName: 'approve', args: [permit2, 0n] })), 'revoke Permit2 allowance');
  await setupTx(await operatorWallet.writeContract(bounded({ address: A.usdc, abi: tokenAbi, functionName: 'approve', args: [A.refundCollector, 0n] })), 'revoke refund allowance');
  report.finalEth = { payer: await pc.getBalance({ address: payer.address }), operator: await pc.getBalance({ address: operator.address }) };
  report.transactions.sort((a, b) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)));
  report.sdkEndToEndWithoutWorkarounds = report.issues.length === 0;
  report.complete = true; report.finishedAt = new Date().toISOString(); await save();
  console.log(`Verification complete: ${report.transactions.length} public lifecycle transactions; ${report.checks.length} checks; ${report.issues.length} SDK issue(s). ${output}`);
} finally { ss.close(); fs.close(); }
