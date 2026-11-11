#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="/workspace"
BUILD_TMP="/tmp/sqlite-rebuild"

rm -rf "${BUILD_TMP}"
mkdir -p "${BUILD_TMP}"

echo "=== Extracting SQLite 3.54.1 sources ==="
unzip -q "${ROOT_DIR}/downloads/sqlite-src-3540100.zip" -d "${BUILD_TMP}"
SRC_DIR="${BUILD_TMP}/sqlite-src-3540100"

echo "=== Placing vec1.c and extra init ==="
cp "${ROOT_DIR}/downloads/vec1.c" "${SRC_DIR}/ext/wasm/vec1.c"
cp "${ROOT_DIR}/docker/sqlite-runtime-build/sqlite3_wasm_extra_init.c" "${SRC_DIR}/ext/wasm/sqlite3_wasm_extra_init.c"

echo "=== Applying patches via patch_sqlite.py ==="
python3 "${ROOT_DIR}/docker/sqlite-runtime-build/patch_sqlite.py" "${SRC_DIR}"

cd "${SRC_DIR}"

echo "=== Configuring SQLite ==="
./configure --disable-readline --disable-tcl

echo "=== Regenerating Lemon parser (parse.c, parse.h) ==="
rm -f parse.c parse.h
make parse.c

echo "=== Building sqlite3.c (Amalgamation) ==="
make sqlite3.c

echo "=== Re-verifying and patching sqlite3.c directly ==="
python3 "${ROOT_DIR}/docker/sqlite-runtime-build/patch_sqlite.py" "${SRC_DIR}"

cd ext/wasm

echo "=== Building Wasm npm bundle (ext/wasm) ==="
make -j2 npm bin.wasm-opt=

echo "=== Extracting generated artifacts to downloads/sqlite-official ==="
OUT_DIR="${ROOT_DIR}/downloads/sqlite-official"
mkdir -p "${OUT_DIR}"

unzip -q -o npm-bundle.zip -d "${BUILD_TMP}/npm-extracted"

FILES=(
  sqlite3.wasm
  sqlite3-node.mjs
  sqlite3-bundler-friendly.mjs
  sqlite3.mjs
  sqlite3-opfs-async-proxy.js
  sqlite3-worker1.mjs
  sqlite3-worker1-bundler-friendly.mjs
  sqlite3-worker1-promiser.mjs
)

for f in "${FILES[@]}"; do
  cp -f "${BUILD_TMP}/npm-extracted/jswasm/${f}" "${OUT_DIR}/${f}"
  chmod 644 "${OUT_DIR}/${f}"
done

echo "=== Running verify-sqlite.mjs verification ==="
node "${ROOT_DIR}/docker/sqlite-runtime-build/verify-sqlite.mjs" "${OUT_DIR}"

echo "=== SQLite Rebuild Completed Successfully ==="
