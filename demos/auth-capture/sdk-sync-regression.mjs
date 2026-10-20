import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { ADDRESSES as A, json } from './contracts.mjs';

// Reproduce the core/scheme integration mismatch without broadcasting or changing upstream.
assert.ok(process.env.X402_SDK_DIR, 'Set X402_SDK_DIR to the pinned SDK checkout');
const sdk = resolve(process.env.X402_SDK_DIR);
assert.equal(execFileSync('git', ['-C', sdk, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), 'faa1c694c66a3732aaabbce93bdae140e521a67d');
const at = (pkg, subpath) => import(pathToFileURL(`${sdk}/typescript/packages/${pkg}/dist/esm/${subpath}/index.mjs`));
const [{ x402ResourceServer }, { x402Client }, { AuthCaptureEvmScheme: Client }, { AuthCaptureEvmScheme: Server, InMemoryAuthorizedPaymentStorage }] = await Promise.all([
  at('core', 'server'), at('core', 'client'), at('mechanisms/evm', 'auth-capture/client'), at('mechanisms/evm', 'auth-capture/server'),
]);
const payer = privateKeyToAccount(generatePrivateKey());
const authorizer = privateKeyToAccount(generatePrivateKey());
const operator = privateKeyToAccount(generatePrivateKey()).address;
const storage = new InMemoryAuthorizedPaymentStorage();
const writes = [];
const facilitator = {
  async getSupported() { return { kinds: [{ x402Version: 2, scheme: 'auth-capture', network: 'eip155:84532', extra: { captureAuthorizer: operator } }], extensions: [], signers: { 'eip155:*': [operator] } }; },
  async verify() { return { isValid: true, payer: payer.address }; },
  async settle(payload, requirements) {
    writes.push({ type: payload.payload.type ?? 'collect', amount: requirements.amount, hasPaymentInfo: Boolean(payload.payload.paymentInfo) });
    return { success: true, transaction: `0x${String(writes.length).padStart(64, '0')}`, network: 'eip155:84532', payer: payer.address, amount: requirements.amount };
  },
};
const scheme = new Server({ storage, receiverAuthorizerSigner: authorizer });
const server = new x402ResourceServer(facilitator).register('eip155:84532', scheme);
await server.initialize();
const client = new x402Client().register('eip155:84532', new Client(payer));
const now = Math.floor(Date.now() / 1000);
const requirements = { scheme: 'auth-capture', network: 'eip155:84532', amount: '10000', asset: A.usdc, payTo: operator, maxTimeoutSeconds: 60,
  extra: { captureAuthorizer: operator, captureDeadline: now + 1200, refundDeadline: now + 3600, feeRecipient: operator,
    minFeeBps: 100, maxFeeBps: 100, name: 'USDC', version: '2', paymentFlow: 'escrow', captureMode: 'sync', operatorType: 'delegated', receiverAuthorizer: authorizer.address } };
const required = await server.createPaymentRequiredResponse([requirements], { url: 'http://127.0.0.1/regression', description: 'sync storage regression', mimeType: 'application/json' });
const payload = await client.createPaymentPayload(required);
const req = required.accepts[0];
await server.settlePayment(payload, req, undefined, undefined, undefined, 'before-handler');
const before = (await storage.list())[0];
await server.settlePayment(payload, req, undefined, undefined, { amount: '60%' }, 'after-handler');
const after = (await storage.list())[0];
assert.deepEqual(writes.map(x => x.type), ['collect', 'capture']);
assert.equal(writes[1].amount, '6000');
assert.equal(writes[1].hasPaymentInfo, true);
assert.equal(payload.payload.type, undefined, 'Core intentionally preserves caller payload');
assert.equal(before.capturableAmount, '10000'); assert.equal(before.refundableAmount, '0');
assert.equal(after.capturableAmount, '10000'); assert.equal(after.refundableAmount, '0');
const report = { generatedAt: new Date().toISOString(), sdkCommit: 'faa1c694c66a3732aaabbce93bdae140e521a67d',
  mode: 'local SDK integration with stub facilitator; no RPC, no transactions', reproduced: true,
  settleCalls: writes, storedAfterAuthorize: { capturable: before.capturableAmount, refundable: before.refundableAmount },
  storedAfterSyncCapture: { capturable: after.capturableAmount, refundable: after.refundableAmount },
  expectedAfterCaptureAndVoid: { capturable: '0', refundable: '6000' },
  cause: 'x402ResourceServer settles enriched settlePayload, then constructs resultContext from original context. AuthCaptureSettlementHooks.handleAfterSettle expects type=capture on that original payload and skips storage update.' };
await writeFile(new URL('./results/sdk-sync-regression.json', import.meta.url), `${json(report)}\n`);
console.log('Reproduced: facilitator receives capture; SDK storage remains authorize=10000/refundable=0. No public transaction sent.');
