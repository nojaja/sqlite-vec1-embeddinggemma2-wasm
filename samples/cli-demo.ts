/**
 * 処理名: CLI デモ
 * 処理概要: 製品エントリを初期化し、VECTOR(768 , 'embeddinggemma-2') STRICT テーブルを作成、埋め込み挿入、類似度検索を実行する。
 * 実装理由: README 利用例および E2E テストで製品全体の推論・SQL統合機能を実証するため。
 */
import sqlite3InitModule from "../src/index";

async function main(): Promise<void> {
  const sqlite3 = await sqlite3InitModule({
    embedding: {
      model: { network: "offline" }
    }
  });
  const db = new sqlite3.oo1.DB(":memory:");
  try {
    const ddl = `CREATE TABLE documents (
  id INTEGER PRIMARY KEY,
  text_data TEXT NOT NULL,
  embedding VECTOR(768 , 'embeddinggemma-2')
) STRICT;`;

    console.log("実行 DDL:\n" + ddl);
    db.exec(ddl);

    const insertStmt = db.prepare("INSERT INTO documents(id, text_data, embedding) VALUES(?, ?, embedding(?))");
    try {
      insertStmt.bind([1, "猫が日向ぼっこをしている", "猫が日向ぼっこをしている"]).step();
      insertStmt.reset();
      insertStmt.bind([2, "赤いスポーツカーが道路を走る", "赤いスポーツカーが道路を走る"]).step();
      insertStmt.reset();
      insertStmt.bind([3, "子犬が公園で元気に走っている", "子犬が公園で元気に走っている"]).step();
    } finally {
      insertStmt.finalize();
    }

    const queryStmt = db.prepare("SELECT id, text_data, DISTANCE(embedding, embedding_query(?)) AS distance FROM documents ORDER BY DISTANCE(embedding, embedding_query(?)), id LIMIT 3;");
    try {
      queryStmt.bind(["かわいい猫", "かわいい猫"]);
      console.log("\n--- 検索結果 (クエリ: 'かわいい猫') ---");
      while (queryStmt.step()) {
        const row = queryStmt.get({});
        console.log(`id: ${row.id}, text: ${row.text_data}, distance: ${row.distance}`);
      }
    } finally {
      queryStmt.finalize();
    }

    console.log("\n契約クエリの完全一致実行に成功しました！");
  } finally {
    db.close();
    await (sqlite3 as any).embedding?.close();
  }
}

main().catch((err) => {
  console.error("CLI Demo error:", err);
  process.exit(1);
});
