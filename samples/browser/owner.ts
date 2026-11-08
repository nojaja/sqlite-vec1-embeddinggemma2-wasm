import type { ProductInitOptions, ProductSqlite3 } from "../../src/official/types";

/**
 * 処理名: サンプルブラウザDB所有Worker
 * 処理概要: OPFS SAH Poolを用いてブラウザ側で同期SQLiteトランザクションを実行する。
 * 実装理由: メインスレッドからDBストレージアクセスを分離するため。
 * @param network - ネットワーク設定
 */
export async function runOwnedBrowser(network: "allow" | "offline" = "allow"): Promise<void> {
  const root = location.origin;
  const module = await import("../../src/index-browser") as { default: (options?: ProductInitOptions) => Promise<ProductSqlite3> };
  const sqlite3 = await module.default({ embedding: { model: { network, baseUrl: root + "/models/fixed/" }, backend: "wasm" } });
  const pool = await sqlite3.installOpfsSAHPoolVfs({ name: "official-sample", directory: "/official-sample", clearOnInit: false, preserveOnInitFailure: true });
  const database = new pool.OpfsSAHPoolDb("/documents.sqlite3");
  try {
    database.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL");
    database.exec("CREATE TABLE IF NOT EXISTS documents(id INTEGER PRIMARY KEY, vector BLOB NOT NULL CHECK(length(vector)=3072)) STRICT");
  } finally {
    database.close();
  }
  await sqlite3.embedding.close();
}

if (typeof (globalThis as unknown as { __SVW_WALKTHROUGH_ONLINE__?: unknown }).__SVW_WALKTHROUGH_ONLINE__ === "undefined") {
  (globalThis as unknown as { __SVW_WALKTHROUGH_ONLINE__: unknown }).__SVW_WALKTHROUGH_ONLINE__ = () => runOwnedBrowser("allow");
}
if (typeof (globalThis as unknown as { __SVW_WALKTHROUGH_OFFLINE__?: unknown }).__SVW_WALKTHROUGH_OFFLINE__ === "undefined") {
  (globalThis as unknown as { __SVW_WALKTHROUGH_OFFLINE__: unknown }).__SVW_WALKTHROUGH_OFFLINE__ = () => runOwnedBrowser("offline");
}
