import type { ProductInitOptions, ProductSqlite3 } from "../../../src/official/types";

/**
 * 処理名: 公式DB所有Worker試験
 * 処理概要: 同期公式SQL内で実modelを呼び出し終了する。
 * 実装理由: main thread上の非同期代用を受け入れないため。
 * @param event - backendとnetwork条件。
 * @returns 検証完了。
 */
async function runOfficialBrowserOwner(event: MessageEvent<{ backend: "wasm" | "webgpu"; network: "allow" | "offline" }>): Promise<void> {
  const root = location.origin;
  const module = await import(root + "/dist/browser/index.mjs") as { default: (options?: ProductInitOptions) => Promise<ProductSqlite3> };
  const sqlite3 = await module.default({ embedding: { model: { network: event.data.network, baseUrl: root + "/models/fixed/" }, backend: event.data.backend } });
  const pool = await sqlite3.installOpfsSAHPoolVfs({ name: "official-product-test", directory: "/official-product-test", clearOnInit: false, preserveOnInitFailure: true });
  const database = new pool.OpfsSAHPoolDb("/documents.sqlite3");
  try {
    database.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL");
    if (event.data.network === "allow") {
      database.exec("CREATE TABLE documents(id INTEGER PRIMARY KEY, vector BLOB NOT NULL CHECK(length(vector)=3072)) STRICT");
      database.exec({ sql: "INSERT INTO documents VALUES(1,embedding(?))", bind: ["An apple is a fruit."] });
    }
    if (database.selectValue("SELECT id FROM documents ORDER BY DISTANCE(vector,embedding_query(?)),id", ["apple fruit"]) !== 1) throw new Error("OFFICIAL_BROWSER_SEARCH_FAILED");
    if (database.selectValue("PRAGMA quick_check") !== "ok") throw new Error("OFFICIAL_BROWSER_QUICK_CHECK_FAILED");
  } finally { database.close(); }
  await sqlite3.embedding.close();
  globalThis.postMessage({ status: "passed", backend: event.data.backend, network: event.data.network });
}

globalThis.addEventListener("message", (event: MessageEvent<{ backend: "wasm" | "webgpu"; network: "allow" | "offline" }>) => {
  runOfficialBrowserOwner(event).catch(() => globalThis.postMessage({ status: "failed" }));
});