import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { registerEmbeddingExtension } from "../../src/official/registration";
import type { OfficialFactory } from "../../src/official/types";

/**
 * 処理名: 公式SQL期限検証
 * 処理概要: 推論を含まない長いSQLも実行開始からの期限で停止する。
 * 実装理由: 同期bridgeの待機期限だけへ依存しないため。
 * @returns 検証完了。
 */
async function testOfficialTimeout(): Promise<void> {
  const module = await import(pathToFileURL(resolve("downloads/sqlite-official/sqlite3-node.mjs")).href) as { default: OfficialFactory };
  const sqlite3 = await module.default();
  const extension = registerEmbeddingExtension(sqlite3, () => null, { identity: { modelId: "embeddinggemma-2", revision: "r", fingerprint: "f".repeat(64), profile: "p", backend: "wasm", runtimeGeneration: 1 }, timeoutMs: 1, information: {} });
  const database = new sqlite3.oo1.DB(":memory:");
  try {
    assert.throws(() => database.selectValue("WITH RECURSIVE valueset(value) AS (VALUES(1) UNION ALL SELECT value+1 FROM valueset WHERE value<1000000) SELECT sum(value) FROM valueset"), /E_TIMEOUT/u);
    assert.equal(database.selectValue("SELECT 1"), 1);
    sqlite3.capi.sqlite3_progress_handler(database, 1, () => 1, 0);
    assert.throws(() => database.selectValue("SELECT 1"), /E_CANCELLED/u);
    sqlite3.capi.sqlite3_progress_handler(database, 0, 0, 0);
    assert.equal(database.selectValue("SELECT 1"), 1);
  } finally { database.close(); }
  await extension.close();
  console.log(JSON.stringify({ stage: "official-sql-timeout", status: "passed" }));
}

testOfficialTimeout().catch((failure: unknown) => { console.error(failure); process.exitCode = 1; });