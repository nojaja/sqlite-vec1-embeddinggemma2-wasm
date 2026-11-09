import assert from "node:assert/strict";
import { resolve } from "node:path";
import type { ProductInitOptions, ProductSqlite3 } from "../../src/official/types";

/**
 * 処理名: 公式製品adapter検証
 * 処理概要: 実moduleへauto-extensionを登録し、通常SQLと未準備UDFを確認する。
 * 実装理由: 別SQLiteやmockで新入口の接続登録を代替しないため。
 * @returns 検証完了。
 */
async function testOfficialSqlite(): Promise<void> {
  const module = require(resolve("dist/node/index.js")) as { default: (options?: ProductInitOptions) => Promise<ProductSqlite3> };
  const sqlite3 = await module.default();
  const database = new sqlite3.oo1.DB(":memory:");
  try {
    assert.equal(database.selectValue("SELECT sqlite_version()"), "3.54.1");
    assert.equal(database.selectValue("SELECT vec1_info()"), "version 0.7 (Scalar, single-threaded)");
    assert.equal(database.selectValue("SELECT count(*) FROM pragma_module_list WHERE name='vec1'"), 1);
    assert.equal(database.selectValue("SELECT embedding(NULL)"), null);
    assert.equal(database.selectValue("SELECT embedding_query(NULL, 'embeddinggemma-2')"), null);
    assert.throws(() => database.selectValue("SELECT embedding(NULL, 'unknown')"), /E_INPUT/u);
    assert.throws(() => database.selectValue("SELECT embedding('body')"), /E_EMBEDDING_NOT_READY/u);
    assert.throws(() => database.selectValue("SELECT embedding()"), /wrong number/u);
    assert.throws(() => database.selectValue("SELECT embedding('body','embeddinggemma-2','query')"), /wrong number/u);
    assert.equal(database.selectValue("SELECT count(*) FROM sqlite_schema WHERE name='_svw_meta'"), 0);
    database.exec("BEGIN; CREATE TABLE ordinary(value); INSERT INTO ordinary VALUES(1); COMMIT");
    assert.equal(database.selectValue("SELECT value FROM ordinary"), 1);
    database.exec("CREATE VIRTUAL TABLE vectors USING vec1(vector); INSERT INTO vectors(cmd,arg) VALUES('rebuild','{\"index\":\"flat\",\"distance\":\"cos\"}')");
    const schemaSql = String(database.selectValue("SELECT sql FROM sqlite_schema WHERE name='vectors'"));
    assert.match(schemaSql, /CREATE\s+VIRTUAL\s+TABLE\s+.*USING\s+vec1/i);
    // TypeScript ラッパーを介さない低レベル CAPI 直接実行検証 (vec1 仮想テーブル)
    const capiRc = sqlite3.capi.sqlite3_exec(
      database,
      "CREATE VIRTUAL TABLE _raw_native_vec USING vec1(v);",
      0,
      0,
      0
    );
    assert.equal(capiRc, 0);

    // 仕様契約: Lemonパーサー文法拡張およびSTRICTテーブルでのVECTOR型ネイティブ受容 (CAPI直接実行)
    const capiVectorDdlRc = sqlite3.capi.sqlite3_exec(
      database,
      "CREATE TABLE docs (id INTEGER PRIMARY KEY, text_data TEXT NOT NULL, embedding VECTOR(768 , 'embeddinggemma-2')) STRICT;",
      0,
      0,
      0
    );
    assert.equal(capiVectorDdlRc, 0);

    // スキーマ保持検証: sqlite_schema および PRAGMA table_info で完全な型宣言文字列が返ること
    const docsDdl = String(database.selectValue("SELECT sql FROM sqlite_schema WHERE name='docs'"));
    assert.match(docsDdl, /VECTOR\(768\s*,\s*'embeddinggemma-2'\)/i);

    const pragmaRows = database.selectObjects("PRAGMA table_info('docs')") as Array<{ name: string; type: string }>;
    const embeddingCol = pragmaRows.find((col) => col.name === "embedding");
    assert.ok(embeddingCol, "embedding column must exist in docs");
    assert.equal(embeddingCol?.type, "VECTOR(768 , 'embeddinggemma-2')");

    const vector = new Uint8Array(3072); new DataView(vector.buffer).setFloat32(0, 1, true);

    // STRICT BLOB型制約検証: BLOB以外の型（TEXT等）の代入は拒否され、BLOBのみ受容されること
    assert.throws(
      () => database.exec({ sql: "INSERT INTO docs(id, text_data, embedding) VALUES(1, 'sample', 'invalid-text-vector')" }),
      /cannot store TEXT value in BLOB column|datatype mismatch/i
    );
    database.exec({ sql: "INSERT INTO docs(id, text_data, embedding) VALUES(1, 'sample', ?)", bind: [vector] });
    const insertedEmbedding = database.selectValue("SELECT embedding FROM docs WHERE id=1") as Uint8Array;
    assert.equal(insertedEmbedding.byteLength, 3072);
    database.exec({ sql: "INSERT INTO vectors(rowid,vector) VALUES(1,?)", bind: [vector] });
    assert.ok(Math.abs(Number(database.selectValue("SELECT DISTANCE(?,?)", [vector, vector]))) < 1e-6);
    database.exec({ sql: "UPDATE vectors SET vector=? WHERE rowid=1", bind: [vector] });
    database.exec("DELETE FROM vectors WHERE rowid=1");
    assert.equal(database.selectValue("SELECT count(*) FROM vectors"), 0);
    assert.equal(database.selectValue("PRAGMA quick_check"), "ok");
    const info = JSON.parse(String(database.selectValue("SELECT gemma_model_info()"))) as { ready: boolean };
    assert.equal(info.ready, false);
  } finally { database.close(); }
  await sqlite3.embedding.close();
  await sqlite3.embedding.close();
  console.log(JSON.stringify({ stage: "official-product-sqlite", status: "passed", embedding: "disabled", modelRequests: 0 }));
}

testOfficialSqlite().catch((failure: unknown) => { console.error(failure); process.exitCode = 1; });