#!/usr/bin/env bash
set -euo pipefail

demo_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
checkout_dir="${X402_SDK_DIR:-${TMPDIR:-/tmp}/auth-capture-x402-source}"
commit='faa1c694c66a3732aaabbce93bdae140e521a67d'
if [[ ! -d "$checkout_dir/.git" ]]; then
  git clone --filter=blob:none --no-checkout https://github.com/x402-foundation/x402.git "$checkout_dir"
  git -C "$checkout_dir" checkout --detach "$commit"
fi
[[ "$(git -C "$checkout_dir" rev-parse HEAD)" == "$commit" ]] || { echo 'SDK checkout must match the pinned commit.' >&2; exit 1; }
[[ -z "$(git -C "$checkout_dir" diff --name-only HEAD -- typescript/packages)" ]] || { echo 'SDK source has tracked changes.' >&2; exit 1; }
cd "$checkout_dir/typescript"
pnpm --filter @x402/evm... --filter @x402/express... --filter @x402/fetch... install --frozen-lockfile
pnpm --filter @x402/core --filter @x402/evm --filter @x402/extensions --filter @x402/express --filter @x402/fetch build
mkdir -p "$demo_dir/results"
cd packages/mechanisms/evm
pnpm exec vitest run test/unit/auth-capture --reporter=json --outputFile="$demo_dir/results/sdk-tests.raw.json"
node "$demo_dir/summarize-sdk-tests.mjs"
