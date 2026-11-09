import { resolve } from "node:path";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { startLocalModelServer } from "../test/integration/local-model-server";
import type { ProductInitOptions, ProductSqlite3 } from "../src/official/types";

/**
 * 処理名: セマンティック検索ワーカー処理
 * 処理概要: SQLiteインメモリDBを作成し、埋め込みベクトル生成とコサイン距離検索を実行する。
 * 実装理由: EmbeddingGemma-2によるセマンティック検索機能を実証するため。
 * @param baseUrl - モデル配信サーバーのベースURL。
 */
async function runDemoWorker(baseUrl: string): Promise<void> {
  const initModule = require(resolve("dist/node/index.js")) as { default: (options?: ProductInitOptions) => Promise<ProductSqlite3> };
  const sqlite3 = await initModule.default({
    embedding: {
      model: { network: "allow", baseUrl },
      cacheDirectory: resolve(".build/official-model-cache"),
      backend: "wasm"
    }
  });

  const db = new sqlite3.oo1.DB(":memory:");
  try {
    console.log("\n--- 1. テーブル作成 (documents) ---");
    db.exec(`
      CREATE TABLE documents (
        id INTEGER PRIMARY KEY,
        text_data TEXT NOT NULL,
        embedding VECTOR(768 , 'embeddinggemma-2')
      ) STRICT;
    `);
    console.log("CREATE TABLE documents 成功");

    console.log("\n--- 2. embedding UDF によるベクトル生成と保存 ---");
    const documents = [
      { id: 1, text: "美味しいリンゴとオレンジなどの果物。" },
      { id: 2, text: "電気自動車やハイブリッドカーの最新技術。" },
      { id: 3, text: "可愛い犬や猫などのペットの飼育方法。" }
    ];

    const insertStmt = db.prepare("INSERT INTO documents(id, text_data, embedding) VALUES(?, ?, embedding(?))");
    try {
      for (const doc of documents) {
        insertStmt.bind([doc.id, doc.text, doc.text]);
        insertStmt.step();
        insertStmt.reset();
        console.log(`INSERT [id=${doc.id}] "${doc.text}"`);
      }
    } finally {
      insertStmt.finalize();
    }

    console.log("\n--- 3. embedding_query と DISTANCE による類似度順検索 ---");
    const queries = ["新鮮なフルーツ", "自動車の燃費", "子猫のしつけ"];

    for (const query of queries) {
      console.log(`\n検索クエリ: "${query}"`);
      const results: Array<{ id: number; text_data: string; distance: number }> = [];

      /**
       * 処理名: 検索結果行追加
       * 処理概要: 取得したレコードを型安全に抽出して結果配列に格納する。
       * 実装理由: 各行のデータ型を保証して表示処理へ渡すため。
       * @param row - DB行オブジェクト。
       */
      const pushRow = (row: Record<string, unknown>): void => {
        results.push({
          id: Number(row.id),
          text_data: String(row.text_data),
          distance: Number(row.distance)
        });
      };

      db.exec({
        sql: `
          SELECT id, text_data, DISTANCE(embedding, embedding_query(?)) AS distance
          FROM documents
          ORDER BY DISTANCE(embedding, embedding_query(?)), id
          LIMIT 3;
        `,
        bind: [query, query],
        rowMode: "object",
        callback: pushRow
      });

      for (const r of results) {
        console.log(`  [Rank] id: ${r.id}, distance: ${r.distance.toFixed(4)}, text: "${r.text_data}"`);
      }
    }

    console.log("\nすべてのクエリで最も意味的に類似したドキュメントが Rank 1 に抽出されました！");
  } finally {
    db.close();
    await sqlite3.embedding?.close();
  }
}

/**
 * 処理名: セマンティック検索デモメイン処理
 * 処理概要: モデルサーバーを起動し、ワーカーでデモシナリオを実行する。
 * 実装理由: CLIからデモを実行するためのメインエントリを提供するため。
 */
async function main(): Promise<void> {
  const server = await startLocalModelServer();
  const worker = new Worker(__filename, { execArgv: [], workerData: { baseUrl: server.baseUrl } });
  try {
    await new Promise<void>((done, reject) => {
      worker.once("message", (msg: { status: string }) => {
        if (msg.status === "passed") done();
        else reject(new Error("Demo failed"));
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
    console.error(err);
    process.exit(1);
  });
} else {
  runDemoWorker((workerData as { baseUrl: string }).baseUrl)
    .then(() => {
      parentPort?.postMessage({ status: "passed" });
      parentPort?.close();
    })
    .catch((err) => {
      console.error(err);
      parentPort?.postMessage({ status: "failed" });
      parentPort?.close();
    });
}
