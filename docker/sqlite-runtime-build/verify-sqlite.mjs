/**
 * 処理名: 再生成 SQLite WASM 資材検証スクリプト
 * 処理概要: 生成された sqlite3-node.mjs / sqlite3.wasm を Node.js でロードし、
 *           vec1_info, DISTANCE, VECTOR STRICT DDL, 型制約, PRAGMA table_info, CRUD, quick_check を検証する。
 * 実装理由: 不完全なビルド成果物が downloads/sqlite-official へ配備されるのを防ぐため。
 */
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const dir = process.argv[2] || "downloads/sqlite-official";
const nodeLoaderPath = path.resolve(dir, "sqlite3-node.mjs");
const wasmPath = path.resolve(dir, "sqlite3.wasm");

assert.ok(fs.existsSync(nodeLoaderPath), `Missing ${nodeLoaderPath}`);
assert.ok(fs.existsSync(wasmPath), `Missing ${wasmPath}`);

const initSqlite3 = (await import(nodeLoaderPath)).default;
const sqlite3 = await initSqlite3({
  wasmBinary: fs.readFileSync(wasmPath)
});

console.log("[VERIFY] Initialized SQLite version:", sqlite3.capi.sqlite3_libversion());
const db = new sqlite3.oo1.DB(":memory:");

try {
  // 1. vec1_info()
  const vec1Info = db.selectValue("SELECT vec1_info()");
  console.log("[VERIFY] vec1_info:", vec1Info);
  assert.equal(vec1Info, "version 0.8 (Scalar, single-threaded)");

  // 2. DISTANCE 関数
  const v1 = new Uint8Array(3072);
  new DataView(v1.buffer).setFloat32(0, 1.0, true);
  const dist = db.selectValue("SELECT DISTANCE(?, ?)", [v1, v1]);
  console.log("[VERIFY] DISTANCE self:", dist);
  assert.ok(Math.abs(dist) < 1e-6);

  // 3. VECTOR(768, 'embeddinggemma-2') STRICT DDL の CAPI 直接実行
  const ddl = "CREATE TABLE docs (id INTEGER PRIMARY KEY, text_data TEXT NOT NULL, embedding VECTOR(768 , 'embeddinggemma-2')) STRICT;";
  const rc = sqlite3.capi.sqlite3_exec(db, ddl, 0, 0, 0);
  const errmsg = sqlite3.capi.sqlite3_errmsg(db);
  console.log("[VERIFY] CAPI DDL result rc:", rc, "errmsg:", errmsg);
  assert.equal(rc, 0, `CAPI exec of VECTOR STRICT DDL must succeed: ${errmsg}`);

  // 4. PRAGMA table_info 型文字列完全保持
  const pragmaRows = db.selectObjects("PRAGMA table_info('docs')");
  const embCol = pragmaRows.find(c => c.name === "embedding");
  assert.ok(embCol, "embedding column must exist");
  assert.equal(embCol.type, "VECTOR(768 , 'embeddinggemma-2')");

  // 5. STRICT BLOB 型制約 (TEXT 等の代入拒否)
  assert.throws(
    () => db.exec("INSERT INTO docs(id, text_data, embedding) VALUES(1, 'txt', 'invalid-text-blob')"),
    /cannot store TEXT value in VECTOR column/i
  );

  // 6. BLOB 代入受容
  db.exec({
    sql: "INSERT INTO docs(id, text_data, embedding) VALUES(1, 'valid', ?)",
    bind: [v1]
  });
  const inserted = db.selectValue("SELECT embedding FROM docs WHERE id=1");
  assert.equal(inserted.byteLength, 3072);

  // 7. PRAGMA quick_check
  assert.equal(db.selectValue("PRAGMA quick_check"), "ok");

  console.log("[VERIFY] All verification checks PASSED successfully!");
} finally {
  db.close();
}
