#!/usr/bin/env bash
set -euo pipefail

: "${GITHUB_PATH:?GITHUB_PATH must be set by GitHub Actions}"

tools_root="${TINYMIST_TOOLS_DIR:-$HOME/.cache/tinymist-tools}"
mkdir -p "$tools_root"

yarn_prefix="$tools_root/yarn/1.22.22"
yarn_bin="$yarn_prefix/node_modules/.bin"
if [ ! -x "$yarn_bin/yarn" ] || [ "$("$yarn_bin/yarn" --version 2>/dev/null || true)" != "1.22.22" ]; then
  npm install --prefix "$yarn_prefix" --cache "$HOME/.npm" yarn@1.22.22
fi
echo "$yarn_bin" >> "$GITHUB_PATH"
export PATH="$yarn_bin:$PATH"

wasm_pack_home="$tools_root/wasm-pack/0.15.1"
wasm_pack_bin="$wasm_pack_home/wasm-pack"
if [ ! -x "$wasm_pack_bin" ] || [ "$("$wasm_pack_bin" --version 2>/dev/null || true)" != "wasm-pack 0.15.1" ]; then
  archive="$tools_root/wasm-pack-v0.15.1-x86_64-unknown-linux-musl.tar.gz"
  install_dir="$tools_root/wasm-pack-extract"
  mkdir -p "$install_dir" "$wasm_pack_home"
  if [ ! -s "$archive" ]; then
    curl --fail --location --silent --show-error \
      "https://github.com/wasm-bindgen/wasm-pack/releases/download/v0.15.1/wasm-pack-v0.15.1-x86_64-unknown-linux-musl.tar.gz" \
      --output "$archive"
  fi
  echo "410101009739b9d01c7d5affaaad6e9c9a24b4cba6791a4805db8e89b9bf7af2  $archive" | sha256sum --check --status
  tar -xzf "$archive" -C "$install_dir"
  binary="$(find "$install_dir" -type f -name wasm-pack -print -quit)"
  test -n "$binary"
  install -m 0755 "$binary" "$wasm_pack_bin"
fi
echo "$wasm_pack_home" >> "$GITHUB_PATH"
export PATH="$wasm_pack_home:$PATH"

node --version
npm --version
yarn --version
wasm-pack --version
