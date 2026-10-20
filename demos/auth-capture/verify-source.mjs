import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import solc from 'solc';
import { createPublicClient, http, keccak256 } from 'viem';
import { baseSepolia } from 'viem/chains';
import { ADDRESSES, CHAIN_ID, FORK_BLOCK, SOURCE_COMMIT, escrowAbi, json } from './contracts.mjs';

const client = createPublicClient({ chain: baseSepolia, transport: http(process.env.BASE_SEPOLIA_RPC || 'https://sepolia.base.org', { fetchOptions: { headers: { 'User-Agent': 'auth-capture-validation/1.0' } } }) });
assert.equal(await client.getChainId(), CHAIN_ID);
assert.match(solc.version(), /^0\.8\.28\+/);
const sha256 = s => createHash('sha256').update(s).digest('hex');
function tokens(source) {
  // Keep strings intact; discard comments and whitespace only.
  const parts = source.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\/[^\n]*|\/\*[\s\S]*?\*\/|\s+|[^\s]/g) || [];
  return parts.filter(x => !/^\s|^\/\/|^\/\*/.test(x)).join('');
}
function normalizeImmutable(code, references) {
  let normalized = code.replace(/^0x/, '');
  for (const ranges of Object.values(references)) for (const { start, length } of ranges) {
    assert.ok(start >= 0 && (start + length) * 2 <= normalized.length);
    normalized = normalized.slice(0, start * 2) + '0'.repeat(length * 2) + normalized.slice((start + length) * 2);
  }
  return `0x${normalized}`;
}
const report = { checkedAt: new Date().toISOString(), chainId: CHAIN_ID, blockNumber: FORK_BLOCK, compiler: solc.version(), sourceCommit: SOURCE_COMMIT, contracts: {} };
const addresses = { ...ADDRESSES, tokenStoreImplementation: await client.readContract({ address: ADDRESSES.escrow, abi: escrowAbi, functionName: 'tokenStoreImplementation' }) };
for (const name of ['escrow', 'erc3009', 'permit2Collector', 'refundCollector', 'tokenStoreImplementation']) {
  const address = addresses[name];
  const api = `https://base-sepolia.blockscout.com/api/v2/smart-contracts/${address}`;
  const response = await fetch(api, { headers: { 'User-Agent': 'auth-capture-validation/1.0' } });
  assert.ok(response.ok, `${name}: explorer returned ${response.status}`);
  const verified = await response.json();
  assert.equal(verified.is_verified, true);
  const sourceUrl = `https://raw.githubusercontent.com/base/commerce-payments/${SOURCE_COMMIT}/${verified.file_path}`;
  const pinned = process.env.COMMERCE_SOURCE
    ? await readFile(resolve(process.env.COMMERCE_SOURCE, verified.file_path), 'utf8')
    : await fetch(sourceUrl).then(async response => { assert.ok(response.ok); return response.text(); });
  assert.equal(tokens(verified.source_code), tokens(pinned), `${name}: executable source differs from pinned contract`);
  const sourceList = [{ file_path: verified.file_path, source_code: verified.source_code }, ...verified.additional_sources];
  const input = { language: 'Solidity', sources: Object.fromEntries(sourceList.map(x => [x.file_path, { content: x.source_code }])), settings: { ...verified.compiler_settings, outputSelection: { [verified.file_path]: { [verified.name]: ['evm.deployedBytecode.object', 'evm.deployedBytecode.immutableReferences'] } } } };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors || []).filter(x => x.severity === 'error');
  assert.deepEqual(errors, [], `${name}: recompilation failed`);
  const compiled = output.contracts[verified.file_path][verified.name].evm.deployedBytecode;
  const deployed = await client.getCode({ address, blockNumber: FORK_BLOCK });
  assert.equal(deployed.toLowerCase(), verified.deployed_bytecode.toLowerCase(), `${name}: explorer/RPC runtime mismatch`);
  const normalizedCompiled = normalizeImmutable(compiled.object, compiled.immutableReferences);
  const normalizedDeployed = normalizeImmutable(deployed, compiled.immutableReferences);
  const exactRuntimeMatch = normalizedCompiled === normalizedDeployed;
  function splitMetadata(code) {
    const length = Number.parseInt(code.slice(-4), 16) + 2;
    assert.ok(length > 2 && length * 2 < code.length);
    const trailer = code.slice(-length * 2);
    // Solidity 0.8.28 IPFS + compiler-version CBOR trailer, not executable code.
    assert.match(trailer, /^a2646970667358221220[0-9a-f]{64}64736f6c634300081c0033$/);
    return { executable: code.slice(0, -length * 2), trailer };
  }
  const compiledParts = splitMetadata(normalizedCompiled);
  const deployedParts = splitMetadata(normalizedDeployed);
  assert.equal(compiledParts.executable, deployedParts.executable, `${name}: executable bytecode differs`);
  report.contracts[name] = { address, api, sourceUrl, explorerVerified: true, primarySourceExact: verified.source_code === pinned, primaryExecutableTokensMatch: true, pinnedSourceSha256: sha256(pinned), verifiedSourceSha256: sha256(verified.source_code), exactRuntimeMatchAfterImmutableNormalization: exactRuntimeMatch, executableBytecodeMatchAfterImmutableNormalization: true, metadataMatches: compiledParts.trailer === deployedParts.trailer, compiledMetadata: compiledParts.trailer, deployedMetadata: deployedParts.trailer, immutableReferences: compiled.immutableReferences, rpcRuntimeHash: keccak256(deployed), normalizedRuntimeHash: keccak256(normalizedDeployed), compilerVersion: verified.compiler_version, optimizerRuns: verified.optimization_runs, viaIR: verified.compiler_settings.viaIR || false, evmVersion: verified.evm_version };
  console.log(`${name}: primary executable source matches; recompiled executable bytecode matches; metadata match=${exactRuntimeMatch} (${Object.values(compiled.immutableReferences).flat().length} immutable ranges normalized).`);
}
await mkdir(new URL('./results/', import.meta.url), { recursive: true });
await writeFile(new URL('./results/verified-source.json', import.meta.url), json(report) + '\n');
