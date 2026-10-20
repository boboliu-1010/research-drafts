#!/usr/bin/env bash
set -euo pipefail

# Keep the official source unchanged; write test output beside the demo.
demo_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
forge_bin="${FORGE_BIN:-forge}"
checkout_dir="${COMMERCE_SOURCE:-${TMPDIR:-/tmp}/auth-capture-official-source}"
commit='b748fdd7a830a655a19a530edcf2a94b9dc7d25f'
version_line="$("$forge_bin" --version | head -n 1)"
[[ "$version_line" == *'1.3.6'* ]] || { echo 'Use Foundry v1.3.6, as pinned by upstream CI. Set FORGE_BIN to its forge executable.' >&2; exit 1; }

if [[ ! -d "$checkout_dir/.git" ]]; then
  git clone --filter=blob:none --no-checkout https://github.com/base/commerce-payments.git "$checkout_dir"
  git -C "$checkout_dir" checkout --detach "$commit"
fi
[[ "$(git -C "$checkout_dir" rev-parse HEAD)" == "$commit" ]] || { echo 'Source checkout must match the pinned commit.' >&2; exit 1; }
[[ -z "$(git -C "$checkout_dir" status --porcelain --untracked-files=no)" ]] || { echo 'Official checkout has tracked changes.' >&2; exit 1; }
git -C "$checkout_dir" submodule update --init --recursive --jobs 8
mkdir -p "$demo_dir/results"
"$forge_bin" --version > "$demo_dir/results/official-toolchain.txt"
cd "$checkout_dir"
"$forge_bin" test --use 0.8.28 --no-match-path 'test/integration/*' --json > "$demo_dir/results/official-tests.json"
node "$demo_dir/summarize-tests.mjs"
