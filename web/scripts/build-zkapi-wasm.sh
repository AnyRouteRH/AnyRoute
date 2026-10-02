#!/usr/bin/env bash
set -euo pipefail
# ZK9: build only licensed Rust source from the immutable commit, never sdk/ assets.
pin=045b444ea1b52538d1b40273c7cb6ed09468a052
: "${ZKAPI_SOURCE:?Set ZKAPI_SOURCE to the upstream Git checkout}"
web_root="$(cd "$(dirname "$0")/.." && pwd)"
command -v wasm-bindgen >/dev/null
[[ "$(rustc --version | awk '{print $2}')" == '1.96.0' ]] || { echo 'Rust 1.96.0 is required'; exit 1; }
[[ "$(wasm-bindgen --version)" == 'wasm-bindgen 0.2.117' ]] || { echo 'wasm-bindgen-cli 0.2.117 is required'; exit 1; }
build_dir="$(mktemp -d "${TMPDIR:-/tmp}/zkapi-browser.XXXXXX")"
trap 'rm -rf "$build_dir"' EXIT
git -C "$ZKAPI_SOURCE" archive "$pin" protocol/rust | tar -x -C "$build_dir"
export CARGO_TARGET_DIR="${ZKAPI_WASM_TARGET_DIR:-$build_dir/target}"
# Strip host paths from panic/debug strings embedded in the distributed WASM.
export RUSTFLAGS="--remap-path-prefix=$build_dir=/source --remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/cargo --remap-path-prefix=$(rustc --print sysroot)=/rust"
cargo build --manifest-path "$build_dir/protocol/rust/Cargo.toml" --locked --release --target wasm32-unknown-unknown -p zkapi-browser
wasm-bindgen "$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/zkapi_browser.wasm" --target web --no-typescript --out-dir "$web_root/public/zkapi"
node "$web_root/scripts/zkapi-provenance.mjs" "$build_dir/protocol/rust/Cargo.lock"
