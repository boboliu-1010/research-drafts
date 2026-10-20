import { readFileSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';

// Pipe a secret manager's JSON output here. Never place keys in command arguments or logs.
// Expected fields: payerKey, operatorKey, merchant (public address), fee (public address).
export async function loadAccounts() {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const accounts = { payer: privateKeyToAccount(input.payerKey), operator: privateKeyToAccount(input.operatorKey), merchant: input.merchant, fee: input.fee };
  delete input.payerKey; delete input.operatorKey;
  return accounts;
}
