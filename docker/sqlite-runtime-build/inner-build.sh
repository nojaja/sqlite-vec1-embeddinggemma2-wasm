#!/usr/bin/env bash
set -euo pipefail

echo "=== Preparing host tools (Tcl and wabt) ==="
if [ -d "/workspace/downloads/sqlite-official-host" ] && ls /workspace/downloads/sqlite-official-host/*.deb >/dev/null 2>&1; then
  echo "Extracting host deb packages from /workspace/downloads/sqlite-official-host..."
  mkdir -p /tmp/host-tools
  cd /tmp/host-tools

  ar -x /workspace/downloads/sqlite-official-host/tcl8.6_*.deb
  tar -xf data.tar.*
  rm -f data.tar.* control.tar.* debian-binary

  ar -x /workspace/downloads/sqlite-official-host/libtcl8.6_*.deb
  tar -xf data.tar.*
  rm -f data.tar.* control.tar.* debian-binary

  ar -x /workspace/downloads/sqlite-official-host/zlib1g_*.deb
  tar -xf data.tar.*
  rm -f data.tar.* control.tar.* debian-binary

  ar -x /workspace/downloads/sqlite-official-host/wabt_*.deb
  tar -xf data.tar.*
  rm -f data.tar.* control.tar.* debian-binary

  ln -sf /tmp/host-tools/usr/bin/tclsh8.6 /tmp/host-tools/usr/bin/tclsh
  export PATH="/tmp/host-tools/usr/bin:$PATH"
  export LD_LIBRARY_PATH="/tmp/host-tools/usr/lib/x86_64-linux-gnu:${LD_LIBRARY_PATH:-}"
  export TCL_LIBRARY="/tmp/host-tools/usr/share/tcltk/tcl8.6"
elif ! command -v tclsh >/dev/null 2>&1 || ! command -v wasm-strip >/dev/null 2>&1; then
  echo "Installing tcl and wabt via apt-get..."
  apt-get update
  apt-get install -y --no-install-recommends tcl wabt
fi

echo "Tcl check:"
tclsh <<< 'puts "Tcl OK: [info patchlevel]"'

echo "wasm-strip check:"
wasm-strip --version

echo "=== Extracting SQLite Source ==="
rm -rf /tmp/sqlite-build
mkdir -p /tmp/sqlite-build
cd /tmp/sqlite-build
unzip -q /workspace/downloads/sqlite-src-3540100.zip
cd sqlite-src-3540100

echo "VERSION: $(cat VERSION)"

echo "=== Patching and preparing vec1.c in ext/wasm ==="
mkdir -p ext/wasm
if [ -f "ext/vec1/vec1.c" ]; then
  cp ext/vec1/vec1.c ext/wasm/vec1.c
elif [ -f "/workspace/downloads/vec1.c" ]; then
  cp /workspace/downloads/vec1.c ext/wasm/vec1.c
else
  echo "ERROR: vec1.c not found in ext/vec1/vec1.c or /workspace/downloads/vec1.c"
  exit 1
fi

python3 - <<'EOF'
with open("ext/wasm/vec1.c", "r", encoding="utf-8") as f:
    content = f.read()

# 1. Version 0.7
content = content.replace('#define VEC1_VERSION "0.8"', '#define VEC1_VERSION "0.7"')

# 2. Add static/threads defines at top
static_defs = """
#ifndef VEC1_STATIC
#define VEC1_STATIC 1
#endif
#ifndef VEC1_THREADS
#define VEC1_THREADS 0
#endif
#include <math.h>
"""
content = static_defs + content

# 3. Fix Vec1JobQueue struct in single-threaded dummy section
old_dummy = """#else  /* VEC1_THREADS=0 */

/*
** Dummy implementation of job-queue for single-threaded builds.
*/"""

new_dummy = """#else  /* VEC1_THREADS=0 */

/*
** Dummy implementation of job-queue for single-threaded builds.
*/
struct Vec1JobQueue {
  int nWorker;
};"""
assert old_dummy in content, "old_dummy not found"
content = content.replace(old_dummy, new_dummy)

# 4. Patch vec1FinishWriter for savepoint re-entrancy
old_finish = """static int vec1FinishWriter(Vec1Tab *pTab, int bDiscard){
  int rc = SQLITE_OK;
  if( bDiscard ){
    vec1WriterFinish(pTab->pWriter, SQLITE_ERROR);
  }else{
    rc = vec1WriterFinish(pTab->pWriter, SQLITE_OK);
  }
  pTab->pWriter = 0;
  return rc;
}"""

new_finish = """static int vec1FinishWriter(Vec1Tab *pTab, int bDiscard){
  Vec1Writer *pWriter = pTab->pWriter;
  if( pWriter==0 ) return SQLITE_OK;
  pTab->pWriter = 0;
  if( bDiscard ){
    return vec1WriterFinish(pWriter, SQLITE_ERROR);
  }else{
    return vec1WriterFinish(pWriter, SQLITE_OK);
  }
}"""
assert old_finish in content, "old_finish not found"
content = content.replace(old_finish, new_finish)

# 5. Add DISTANCE function with forward declaration of vec1CosDist
distance_func = """
static double vec1CosDist(const float *a1, const float *a2, int n);

/*
** Implementation of scalar function DISTANCE(left, right).
** Expects two 3072-byte Float32 LE blobs.
** Normalizes them using double precision L2 norm, then calls vec1CosDist.
*/
static void vec1DistanceFunc(
  sqlite3_context *pCtx,
  int nVal,
  sqlite3_value **aVal
){
  const u8 *b1, *b2;
  int n1, n2;
  const float *f1, *f2;
  int i;
  double sum1 = 0.0, sum2 = 0.0;
  double norm1, norm2;
  float normA[768], normB[768];

  if( nVal!=2 ){
    sqlite3_result_error(pCtx, "E_INPUT", -1);
    return;
  }
  if( sqlite3_value_type(aVal[0])!=SQLITE_BLOB || sqlite3_value_type(aVal[1])!=SQLITE_BLOB ){
    sqlite3_result_error(pCtx, "E_INPUT", -1);
    return;
  }
  n1 = sqlite3_value_bytes(aVal[0]);
  n2 = sqlite3_value_bytes(aVal[1]);
  if( n1!=3072 || n2!=3072 ){
    sqlite3_result_error(pCtx, "E_INPUT", -1);
    return;
  }
  b1 = sqlite3_value_blob(aVal[0]);
  b2 = sqlite3_value_blob(aVal[1]);
  if( b1==0 || b2==0 ){
    sqlite3_result_error(pCtx, "E_INPUT", -1);
    return;
  }
  f1 = (const float*)b1;
  f2 = (const float*)b2;

  for(i=0; i<768; i++){
    float val1 = f1[i];
    float val2 = f2[i];
    if( !isfinite(val1) || !isfinite(val2) ){
      sqlite3_result_error(pCtx, "E_INPUT", -1);
      return;
    }
    sum1 += (double)val1 * (double)val1;
    sum2 += (double)val2 * (double)val2;
  }
  norm1 = sqrt(sum1);
  norm2 = sqrt(sum2);
  if( !isfinite(norm1) || !isfinite(norm2) || norm1<=0.0 || norm2<=0.0 ){
    sqlite3_result_error(pCtx, "E_INPUT", -1);
    return;
  }
  for(i=0; i<768; i++){
    normA[i] = (float)((double)f1[i] / norm1);
    normB[i] = (float)((double)f2[i] / norm2);
  }
  sqlite3_result_double(pCtx, vec1CosDist(normA, normB, 768));
}
"""

old_afunc = '{ "vec1_info",        0,      vec1InfoFunc     },'
new_afunc = '{ "DISTANCE",         2,      vec1DistanceFunc },\n    { "vec1_info",        0,      vec1InfoFunc     },'
assert old_afunc in content, "old_afunc not found"
content = content.replace(old_afunc, new_afunc)

content = content.replace("static void vec1InfoFunc(", distance_func + "\nstatic void vec1InfoFunc(")

with open("ext/wasm/vec1.c", "w", encoding="utf-8") as f:
    f.write(content)
print("vec1.c successfully patched!")
EOF

echo "=== Creating sqlite3_wasm_extra_init.c ==="
cat <<'EOF' > ext/wasm/sqlite3_wasm_extra_init.c
#include "sqlite3.h"

/* Include vec1.c directly so it is compiled into sqlite3.wasm */
#include "vec1.c"

int sqlite3_wasm_extra_init(const char *zUnused){
  (void)zUnused;
  return sqlite3_auto_extension((void(*)(void))sqlite3_extension_init);
}
EOF

echo "=== Configuring SQLite ==="
source /emsdk/emsdk_env.sh
./configure --disable-readline --disable-tcl

echo "=== Generating amalgamation (sqlite3.c) ==="
make sqlite3.c

echo "=== Building ext/wasm npm artifacts ==="
cd ext/wasm

make -j2 npm bin.wasm-opt=

echo "=== Extracting and patching npm-bundle.zip ==="
mkdir -p /tmp/npm-extract
unzip -q -o npm-bundle.zip -d /tmp/npm-extract

EXTRACT_DIR=$(find /tmp/npm-extract -mindepth 1 -maxdepth 1 -type d | head -n 1)
if [ -z "$EXTRACT_DIR" ]; then
  EXTRACT_DIR=/tmp/npm-extract
fi

echo "Extracted directory: $EXTRACT_DIR"
ls -la "$EXTRACT_DIR"

python3 - <<EOF
import os, re

directory = "$EXTRACT_DIR"
for root, dirs, files in os.walk(directory):
    for fname in files:
        if fname.endswith(".mjs") or fname.endswith(".js"):
            fpath = os.path.join(root, fname)
            with open(fpath, "r", encoding="utf-8") as f:
                code = f.read()

            modified = False

            # 1. bind_text pMem bug: Array.isArray(pMem) -> Array.isArray(text) and allocCString true length
            if "Array.isArray(pMem)" in code:
                code = code.replace("Array.isArray(pMem)", "Array.isArray(text)")
                code = code.replace("text = pMem.join(", "text = text.join(")
                modified = True

            if "[p, n] = wasm.allocCString(text);" in code:
                code = code.replace("[p, n] = wasm.allocCString(text);", "[p, n] = wasm.allocCString(text, true);")
                modified = True

            if "[p, n] = wasm.allocCString(pMem);" in code:
                code = code.replace("[p, n] = wasm.allocCString(pMem);", "[p, n] = wasm.allocCString(pMem, true);")
                modified = True

            # 2. step warning
            if 'sqlite3.config.warn("sqlite3_step() rc="' in code:
                code = re.sub(
                    r'sqlite3\.config\.warn\("sqlite3_step\(\) rc=",\s*rc,\s*capi\.sqlite3_js_rc_str\(rc\),\s*"SQL =",\s*capi\.sqlite3_sql\(this\.pointer\)\);',
                    'sqlite3.config.warn("SQLITE_STEP_FAILED", rc, capi.sqlite3_js_rc_str(rc));',
                    code
                )
                modified = True

            if modified:
                with open(fpath, "w", encoding="utf-8") as f:
                    f.write(code)
                print(f"Patched {fname}")
EOF

echo "=== Copying official 8 files to /workspace/downloads/sqlite-official ==="
mkdir -p /workspace/downloads/sqlite-official

REQUIRED_FILES=(
  "sqlite3.wasm"
  "sqlite3-node.mjs"
  "sqlite3-bundler-friendly.mjs"
  "sqlite3.mjs"
  "sqlite3-opfs-async-proxy.js"
  "sqlite3-worker1.mjs"
  "sqlite3-worker1-bundler-friendly.mjs"
  "sqlite3-worker1-promiser.mjs"
)

for rf in "${REQUIRED_FILES[@]}"; do
  found=$(find "$EXTRACT_DIR" -name "$rf" | head -n 1)
  if [ -n "$found" ] && [ -f "$found" ]; then
    cp -f "$found" "/workspace/downloads/sqlite-official/$rf"
    echo "Copied $rf"
  else
    echo "ERROR: Missing required file: $rf"
    exit 1
  fi
done

echo "=== Verifying SQLite Build with Node ==="
node - <<'EOF'
async function test() {
  const modPath = '/workspace/downloads/sqlite-official/sqlite3-node.mjs';
  const mod = await import(modPath);
  const factory = mod.default;
  const sqlite3 = await factory();
  
  const db = new sqlite3.oo1.DB(':memory:');
  
  // 1. check vec1_info
  const info = db.selectValue("SELECT vec1_info()");
  console.log("vec1_info:", info);
  if (!info.includes("version 0.7") || !info.includes("Scalar") || !info.includes("single-threaded")) {
    throw new Error("VEC1_INFO_MISMATCH: " + info);
  }

  // 2. check DISTANCE
  const v1 = new Uint8Array(3072);
  const v2 = new Uint8Array(3072);
  new DataView(v1.buffer).setFloat32(0, 1.0, true);
  new DataView(v2.buffer).setFloat32(0, 1.0, true);
  const d = db.selectValue("SELECT DISTANCE(?, ?)", [v1, v2]);
  console.log("DISTANCE:", d);
  if (Math.abs(d) > 1e-5) throw new Error("DISTANCE_FAILED: " + d);

  // 3. check quick_check
  const qc = db.selectValue("PRAGMA quick_check");
  console.log("quick_check:", qc);
  if (qc !== "ok") throw new Error("QUICK_CHECK_FAILED");

  db.close();
  console.log("OFFICIAL_SQLITE_BUILD_COMPLETE=1");
}

test().catch(err => {
  console.error("Verification failed:", err);
  process.exit(1);
});
EOF

echo "Done!"
