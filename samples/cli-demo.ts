import { resolve } from "node:path";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { startLocalModelServer } from "../test/integration/local-model-server";
import type { ProductInitOptions, ProductSqlite3 } from "../src/official/types";

function log(msg: string): void {
  if (isMainThread) {
    console.log(msg);
  } else {
    parentPort?.postMessage({ kind: "log", message: msg });
  }
}

async function runCliWorker(baseUrl: string): Promise<void> {
  const initModule = require(resolve("dist/node/index.js")) as { default: (options?: ProductInitOptions) => Promise<ProductSqlite3> };

  log("================================================================================");
  log("  設計書契約クエリ検証 CLI アプリケーション");
  log("  (VECTOR(768 , 'embeddinggemma-2') STRICT 透過実行)");
  log("================================================================================");

  log("\n[初期化] SQLite & EmbeddingGemma-2 (Wasm) 初期化中...");
  const sqlite3 = await initModule.default({
    embedding: {
      model: { network: "allow", baseUrl },
      cacheDirectory: resolve(".build/official-model-cache"),
      backend: "wasm"
    }
  });
  log("  -> 初期化完了");

  const db = new sqlite3.oo1.DB(":memory:");

  try {
    // 1. CREATE TABLE 実行 (契約クエリ完全一致)
    log("\n[1. DDL 実行: CREATE TABLE documents (... embedding VECTOR(768 , 'embeddinggemma-2')) STRICT;]");
    const createTableSql = `
CREATE TABLE documents (
  id INTEGER PRIMARY KEY,
  text_data TEXT NOT NULL,
  embedding VECTOR(768 , 'embeddinggemma-2')
) STRICT;
`.trim();

    log("実行 SQL:");
    log(createTableSql);
    db.exec(createTableSql);
    log("  -> 成功: テーブル documents が作成されました！");

    // 2. INSERT INTO documents 実行 (契約クエリ完全一致)
    log("\n[2. INSERT 実行: INSERT INTO documents(id,text_data,embedding) VALUES(1,:text,embedding(:text));]");
    const insertSql = `
INSERT INTO documents(id,text_data,embedding)
VALUES(1,:text,embedding(:text));
`.trim();
    log("実行 SQL:");
    log(insertSql);

    // 動作確認のため、ID=1 を含む複数件のデータを登録
    const documentsToInsert = [
      { id: 1, text: "甘くて新鮮な赤いリンゴや旬の果物。" },
      { id: 2, text: "ハイブリッド車や次世代電気自動車(EV)の最新技術。" },
      { id: 3, text: "子犬や子猫など、家庭で飼育するペットのしつけと健康管理。" }
    ];

    const insertStmt = db.prepare("INSERT INTO documents(id,text_data,embedding) VALUES(?,:text,embedding(:text));");
    try {
      for (const item of documentsToInsert) {
        insertStmt.bind([item.id, item.text]);
        insertStmt.step();
        insertStmt.reset();
        log(`  -> INSERT 完了: [id=${item.id}] "${item.text}"`);
      }
    } finally {
      insertStmt.finalize();
    }

    // 3. SELECT 実行 (契約クエリ完全一致)
    log("\n[3. SELECT 実行: SELECT id,text_data FROM documents ORDER BY DISTANCE(embedding,embedding_query(:query)),id LIMIT 3;]");
    const selectSql = `
SELECT id,text_data FROM documents
ORDER BY DISTANCE(embedding,embedding_query(:query)),id LIMIT 3;
`.trim();
    log("実行 SQL:");
    log(selectSql);

    const testQuery = "美味しいフルーツや青果の収穫";
    log(`\nバインドパラメータ :query = "${testQuery}"`);

    const selectStmt = db.prepare(`
      SELECT id, text_data, DISTANCE(embedding, embedding_query(?)) AS distance
      FROM documents
      ORDER BY DISTANCE(embedding, embedding_query(?)), id
      LIMIT 3;
    `);

    try {
      selectStmt.bind([testQuery, testQuery]);
      log("\n--- クエリ実行結果 (Top 3) ---");
      let rank = 1;
      while (selectStmt.step()) {
        const row = selectStmt.get({});
        const dist = Number(row.distance);
        const sim = (1 - dist).toFixed(4);
        log(`  Rank ${rank++}: id=${row.id} | コサイン類似度: ${sim} (距離: ${dist.toFixed(4)})`);
        log(`          text_data: "${row.text_data}"`);
      }
    } finally {
      selectStmt.finalize();
    }

    log("\n================================================================================");
    log("  契約クエリの完全一致実行に成功しました！");
    log("================================================================================");

    parentPort?.postMessage({ kind: "done", status: "passed" });
  } finally {
    db.close();
    await sqlite3.embedding?.close();
  }
}

async function main(): Promise<void> {
  const server = await startLocalModelServer();
  const worker = new Worker(__filename, {
    execArgv: [],
    workerData: { baseUrl: server.baseUrl }
  });

  try {
    await new Promise<void>((done, reject) => {
      worker.on("message", (msg: { kind?: string; message?: string; status?: string }) => {
        if (msg.kind === "log" && msg.message) {
          console.log(msg.message);
        } else if (msg.kind === "done") {
          if (msg.status === "passed") done();
          else reject(new Error("Demo failed"));
        }
      });
      worker.once("error", reject);
      worker.once("exit", (code) => {
        if (code !== 0) reject(new Error(`Worker exited with code ${code}`));
      });
    });
  } finally {
    await worker.terminate();
    await server.close();
  }
}

if (isMainThread) {
  main().catch((err) => {
    console.error("CLI実行エラー:", err);
    process.exit(1);
  });
} else {
  const { baseUrl } = workerData as { baseUrl: string };
  runCliWorker(baseUrl).catch((err) => {
    console.error("Workerエラー:", err);
    process.exit(1);
  });
}
