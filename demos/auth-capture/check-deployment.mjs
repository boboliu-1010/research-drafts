import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createPublicClient, http, keccak256 } from 'viem';
import { baseSepolia } from 'viem/chains';
import { ADDRESSES, CHAIN_ID, FORK_BLOCK, SOURCE_COMMIT, escrowAbi, tokenAbi, collectorAbi, json } from './contracts.mjs';

const rpc = process.env.BASE_SEPOLIA_RPC || 'https://sepolia.base.org';
const client = createPublicClient({ chain: baseSepolia, transport: http(rpc, { fetchOptions: { headers: { 'User-Agent': 'auth-capture-validation/1.0' } } }) });
assert.equal(await client.getChainId(), CHAIN_ID, 'Expected Base Sepolia');
const blockNumber = process.env.BASE_SEPOLIA_BLOCK ? BigInt(process.env.BASE_SEPOLIA_BLOCK) : FORK_BLOCK;
const block = await client.getBlock({ blockNumber });
const contracts = {};
for (const [name, address] of Object.entries(ADDRESSES)) {
  const code = await client.getCode({ address, blockNumber });
  assert.ok(code && code !== '0x', `${name}: no runtime code`);
  contracts[name] = { address, codeBytes: (code.length - 2) / 2, codeHash: keccak256(code), explorer: `https://sepolia.basescan.org/address/${address}#code` };
  if (name.endsWith('Collector') || name === 'erc3009') {
    const boundEscrow = await client.readContract({ address, abi: collectorAbi, functionName: 'authCaptureEscrow', blockNumber });
    const type = await client.readContract({ address, abi: collectorAbi, functionName: 'collectorType', blockNumber });
    assert.equal(boundEscrow.toLowerCase(), ADDRESSES.escrow.toLowerCase());
    assert.equal(type, name === 'refundCollector' ? 1 : 0);
    Object.assign(contracts[name], { boundEscrow, collectorType: type });
    if (name === 'erc3009' || name === 'permit2Collector') {
      const multicall3 = await client.readContract({ address, abi: collectorAbi, functionName: 'multicall3', blockNumber });
      assert.equal(multicall3.toLowerCase(), '0xca11bde05977b3631167028862be2a173976ca11');
      assert.ok((await client.getCode({ address: multicall3, blockNumber }))?.length > 2);
      contracts[name].multicall3 = multicall3;
    }
    if (name === 'permit2Collector') {
      const permit2 = await client.readContract({ address, abi: collectorAbi, functionName: 'permit2', blockNumber });
      assert.equal(permit2.toLowerCase(), '0x000000000022d473030f116ddee9f6b43ac78ba3');
      assert.ok((await client.getCode({ address: permit2, blockNumber }))?.length > 2);
      contracts[name].permit2 = permit2;
    }
  }
}
const implementation = await client.readContract({ address: ADDRESSES.escrow, abi: escrowAbi, functionName: 'tokenStoreImplementation', blockNumber });
const templateCode = await client.getCode({ address: implementation, blockNumber });
assert.ok(templateCode?.length > 2);
const templateEscrow = await client.readContract({ address: implementation, abi: collectorAbi, functionName: 'authCaptureEscrow', blockNumber });
assert.equal(templateEscrow.toLowerCase(), ADDRESSES.escrow.toLowerCase());
contracts.tokenStoreImplementation = { address: implementation, codeBytes: (templateCode.length - 2) / 2, codeHash: keccak256(templateCode), boundEscrow: templateEscrow, explorer: `https://sepolia.basescan.org/address/${implementation}#code` };
const token = {};
for (const functionName of ['name', 'version', 'decimals', 'DOMAIN_SEPARATOR']) {
  token[functionName] = await client.readContract({ address: ADDRESSES.usdc, abi: tokenAbi, functionName, blockNumber });
}
assert.equal(token.decimals, 6);
const report = { mode: 'base-sepolia-read-only', checkedAt: new Date().toISOString(), chainId: CHAIN_ID, rpcHost: new URL(rpc).hostname, blockNumber, blockHash: block.hash, blockTimestamp: block.timestamp, sourceCommit: SOURCE_COMMIT, contracts, tokenStoreImplementation: implementation, token, publicTransactionsSent: 0 };
await mkdir(new URL('./results/', import.meta.url), { recursive: true });
await writeFile(new URL('./results/deployment.json', import.meta.url), json(report) + '\n');
console.log(`Base Sepolia #${blockNumber}: ${Object.keys(contracts).length} contracts have code; collector bindings and types match.`);
console.log(`USDC ${token.name}, version ${token.version}, decimals ${token.decimals}`);
