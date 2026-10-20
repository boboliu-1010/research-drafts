import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { SOURCE_COMMIT, json } from './contracts.mjs';
const suites = JSON.parse(await readFile(new URL('./results/official-tests.json', import.meta.url), 'utf8'));
const counts = { passed: 0, failed: 0, skipped: 0 };
const fuzz = { tests: 0, runs: 0 };
const details = [];
for (const [suite, data] of Object.entries(suites)) {
  const status = { suite, passed: 0, failed: 0, skipped: 0 };
  for (const test of Object.values(data.test_results)) {
    const key = test.status === 'Success' ? 'passed' : test.status === 'Failure' ? 'failed' : 'skipped';
    counts[key]++; status[key]++;
    if (test.kind?.Fuzz) { fuzz.tests++; fuzz.runs += test.kind.Fuzz.runs; }
  }
  details.push(status);
}
const toolchain = await readFile(new URL('./results/official-toolchain.txt', import.meta.url), 'utf8');
const report = { generatedAt: new Date().toISOString(), sourceCommit: SOURCE_COMMIT, command: "forge test --use 0.8.28 --no-match-path 'test/integration/*' --json", toolchain: toolchain.trim(), solidity: '0.8.28', evm: 'cancun', excluded: ['test/integration/* (upstream Base mainnet fork integration tests)'], suiteCount: details.length, counts, fuzz, suites: details };
await writeFile(new URL('./results/official-summary.json', import.meta.url), json(report) + '\n');
assert.equal(counts.failed, 0, 'Official test suite has failures');
console.log(`${counts.passed} passed, ${counts.failed} failed, ${counts.skipped} skipped in ${details.length} suites. ${fuzz.tests} fuzz tests, ${fuzz.runs} generated runs.`);
