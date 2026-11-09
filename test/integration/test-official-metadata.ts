import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { registerEmbeddingExtension } from "../../src/official/registration";
import type { OfficialFactory } from "../../src/official/types";

/**
 * 処理名: 公式接続metadata保護検証
 * 処理概要: 実SQLiteで非空DB拒否と予約表保護・利用者authorizer併用を確認する。
 * 実装理由: 通常接続への旧一律禁止を持ち込まずmodel空間を守るため。
 * @returns 検証完了。
 */
async function testOfficialMetadata(): Promise<void> {
  const module = await import(pathToFileURL(resolve("downloads/sqlite-official/sqlite3-node.mjs")).href) as { default: OfficialFactory };
  const sqlite3 = await module.default();
  const ordinary = new sqlite3.oo1.DB("unbound.sqlite3");
  ordinary.exec("CREATE TABLE existing(value)"); ordinary.close();
  const identity = { modelId: "embeddinggemma-2", revision: "fixed", fingerprint: "f".repeat(64), profile: "fixed", backend: "wasm", runtimeGeneration: 1 };
  const extension = registerEmbeddingExtension(sqlite3, () => null, { identity, timeoutMs: 120000, information: {} });
  assert.throws(() => new sqlite3.oo1.DB("unbound.sqlite3"), /E_MODEL_UNBOUND/u);
  const database = new sqlite3.oo1.DB(":memory:");
  try {
    assert.equal(database.selectValue("SELECT count(*) FROM _svw_meta"), 1);
    assert.throws(() => database.exec("UPDATE _svw_meta SET metadata='{}'"), /authorized|E_MODEL/u);
    assert.throws(() => database.exec("DROP TABLE _svw_meta"), /authorized|E_MODEL/u);
    assert.throws(() => database.exec("PRAGMA writable_schema=ON"), /authorized|E_MODEL/u);
    database.exec("BEGIN; CREATE TABLE business(value); INSERT INTO business VALUES(1); COMMIT");
    assert.equal(database.selectValue("SELECT value FROM business"), 1);
    sqlite3.capi.sqlite3_set_authorizer(database, (_argument: unknown, action: unknown, first: unknown) => action === sqlite3.capi.SQLITE_READ && first === "business" ? sqlite3.capi.SQLITE_DENY : sqlite3.capi.SQLITE_OK, 0);
    assert.throws(() => database.selectValue("SELECT value FROM business"), /prohibited|authorized/u);
    assert.throws(() => database.exec("DELETE FROM _svw_meta"), /authorized|E_MODEL/u);
  } finally { database.close(); }
  await extension.close();
  console.log(JSON.stringify({ stage: "official-metadata", status: "passed" }));
}

testOfficialMetadata().catch((failure: unknown) => { console.error(failure); process.exitCode = 1; });