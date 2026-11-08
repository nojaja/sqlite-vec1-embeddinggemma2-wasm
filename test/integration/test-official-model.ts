import assert from "node:assert/strict";
import { resolve } from "node:path";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import type { ProductInitOptions, ProductSqlite3 } from "../../src/official/types";
import { startLocalModelServer } from "./local-model-server";

/**
 * 処理名: 公式SQL実model検証
 * 処理概要: 固定モデルをloopback経由で準備し同じ公式接続でINSERTと検索を行う。
 * 実装理由: fake engineのcache成功を実推論受入へ読み替えないため。
 * @param baseUrl - 固定modelのloopback配信URL。
 * @returns 検証完了。
 */
async function testOfficialModel(baseUrl: string): Promise<void> {
  const module = require(resolve("dist/node/index.js")) as { default: (options?: ProductInitOptions) => Promise<ProductSqlite3> };
    const sqlite3 = await module.default({ embedding: { model: { network: "allow", baseUrl }, cacheDirectory: resolve(".build/official-model-cache"), backend: "wasm" } });
    const database = new sqlite3.oo1.DB(":memory:");
    try {
      database.exec("CREATE TABLE documents(id INTEGER PRIMARY KEY, text_data TEXT NOT NULL, vector_data BLOB NOT NULL CHECK(length(vector_data)=3072)) STRICT");
      database.exec({ sql: "INSERT INTO documents VALUES(1,?,embedding(?))", bind: ["A red apple grows on a tree.", "A red apple grows on a tree."] });
      assert.equal(database.selectValue("SELECT length(vector_data) FROM documents"), 3072);
      assert.equal(database.selectValue("SELECT id FROM documents ORDER BY DISTANCE(vector_data,embedding_query(?)),id LIMIT 3", ["red apple"]), 1);
      database.exec("WITH RECURSIVE numbers(value) AS (VALUES(2) UNION ALL SELECT value+1 FROM numbers WHERE value<100) INSERT INTO documents SELECT value,'copy',vector_data FROM numbers CROSS JOIN documents WHERE documents.id=1");
      const before = JSON.parse(String(database.selectValue("SELECT gemma_model_info()"))) as { functionCalls: number; cache: { actualInference: number } };
      const plain = database.selectObjects("SELECT id FROM documents ORDER BY DISTANCE(vector_data,embedding_query('apple fruit')),id LIMIT 3");
      const after = JSON.parse(String(database.selectValue("SELECT gemma_model_info()"))) as { functionCalls: number; cache: { actualInference: number } };
      assert.equal(after.cache.actualInference - before.cache.actualInference, 1);
      assert.ok(after.functionCalls - before.functionCalls >= 1);
      const materialized = database.selectObjects("WITH query_vector(vector) AS MATERIALIZED (SELECT embedding_query('apple fruit')) SELECT id FROM documents CROSS JOIN query_vector ORDER BY DISTANCE(vector_data,vector),id LIMIT 3");
      assert.deepEqual(plain, materialized);
      database.exec("CREATE VIRTUAL TABLE document_vectors USING vec1(vector); INSERT INTO document_vectors(cmd,arg) VALUES('rebuild','{\"index\":\"flat\",\"distance\":\"cos\"}'); INSERT INTO document_vectors(rowid,vector) SELECT id,vector_data FROM documents");
      const indexed = database.selectObjects("WITH query_vector(vector) AS MATERIALIZED (SELECT embedding_query('apple fruit')) SELECT documents.id FROM query_vector CROSS JOIN document_vectors(query_vector.vector,'{\"k\":100}') AS candidate JOIN documents ON documents.id=candidate.rowid ORDER BY candidate.distance,documents.id LIMIT 3");
      assert.deepEqual(plain, indexed);
      assert.equal(database.selectValue("PRAGMA quick_check"), "ok");
    } finally { try { database.close(); } finally { await sqlite3.embedding.close(); } }
  console.log(JSON.stringify({ stage: "official-model-sql", status: "passed", backend: "wasm" }));
}

/** 処理名: 公式model所有Worker監視。処理概要: 実Worker内の公開API試験を有限実行する。実装理由: main threadの環境仮指定を受入に使わないため。
 * @returns 監視とcleanupの完了。
 */
async function superviseOfficialModel(): Promise<void> {
  const server = await startLocalModelServer();
  const worker = new Worker(__filename, { execArgv: [], workerData: { baseUrl: server.baseUrl } });
  try {
    await new Promise<void>((complete, reject) => {
      const timer = setTimeout(() => reject(new Error("OFFICIAL_MODEL_OWNER_TIMEOUT")), 600000);
      worker.once("message", (message: { status: string }) => { clearTimeout(timer); if (message.status === "passed") complete(); else reject(new Error("OFFICIAL_MODEL_OWNER_FAILED")); });
      worker.once("error", () => { clearTimeout(timer); reject(new Error("OFFICIAL_MODEL_OWNER_FAILED")); });
    });
  } finally { await worker.terminate(); await server.close(); }
}

if (isMainThread) superviseOfficialModel().catch((failure: unknown) => { console.error(failure); process.exitCode = 1; });
else testOfficialModel((workerData as { baseUrl: string }).baseUrl).then(() => { parentPort?.postMessage({ status: "passed" }); parentPort?.close(); }).catch(() => { parentPort?.postMessage({ status: "failed" }); parentPort?.close(); });