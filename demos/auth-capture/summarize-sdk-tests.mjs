import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';

const raw = JSON.parse(await readFile(new URL('./results/sdk-tests.raw.json', import.meta.url), 'utf8'));
assert.ok(raw.numTotalTests > 0, 'No SDK tests ran');
const summary = {
  sourceCommit: 'faa1c694c66a3732aaabbce93bdae140e521a67d',
  generatedAt: new Date().toISOString(), node: process.version,
  command: 'pnpm exec vitest run test/unit/auth-capture --reporter=json --outputFile=<raw-results.json>',
  success: raw.success,
  counts: { passed: raw.numPassedTests, failed: raw.numFailedTests, skipped: raw.numPendingTests, total: raw.numTotalTests, files: raw.testResults.length },
  files: raw.testResults.map(file => ({ file: file.name.split('/typescript/')[1], status: file.status,
    tests: file.assertionResults.length, passed: file.assertionResults.filter(test => test.status === 'passed').length,
    failed: file.assertionResults.filter(test => test.status === 'failed').map(test => ({ title: test.fullName, messages: test.failureMessages })) })),
};
await writeFile(new URL('./results/sdk-summary.json', import.meta.url), `${JSON.stringify(summary, null, 2)}\n`);
assert.equal(summary.success, true, 'SDK test run failed');
assert.equal(summary.counts.failed, 0);
console.log(summary.counts);
