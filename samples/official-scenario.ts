/**
 * 処理名: 公式サンプルシナリオモジュール
 * 処理概要: テキスト/画像データの投入、セマンティック検索、データ更新・削除トランザクション、vec1 ネイティブ検証機能を提供する。
 * 実装理由: Node/Browser 双方の E2E シナリオで一貫したテストデータおよび検証手続きを共有するため。
 */

export interface Vec1NativeVerification {
  isNative: boolean;
  vec1Info: string;
  vtabVerified: boolean;
}

export interface OfficialSampleReport {
  status: string;
  backend: string;
  database: string;
  inserted: number;
  onlineRequests: number;
  offlineRequests: number;
  initialResults: Array<{ rowid: string; distance: number }>;
  reopenedResults: Array<{ rowid: string; distance: number }>;
  remainingRows: string;
  quickCheck: string;
  rollbackVerified: boolean;
  vec1Verification: Vec1NativeVerification;
}

// 共通 1px PNG バイト列
const TINY_1PX_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82
]);

/**
 * 処理名: 公式サンプルデータ投入
 * 処理概要: 猫、車、犬の3日本語文書および画像文書の計4件を登録する。
 * @param db - SQLite データベースインスタンス。
 * @param stage - 実行ステージ ("online" | "offline")。
 */
export function populateOfficialSample(db: any, stage: string): void {
  const insertStmt = db.prepare("INSERT INTO documents(id, text_data, embedding) VALUES(?, ?, embedding(?))");
  try {
    // id 1: 猫
    insertStmt.bind([1, "猫が日向ぼっこをしている", "猫が日向ぼっこをしている"]).step();
    insertStmt.reset();

    // id 2: 車
    insertStmt.bind([2, "赤いスポーツカーが道路を走る", "赤いスポーツカーが道路を走る"]).step();
    insertStmt.reset();

    // id 3: 犬
    insertStmt.bind([3, "子犬が公園で元気に走っている", "子犬が公園で元気に走っている"]).step();
    insertStmt.reset();

    // id 4: 画像 (または文書)
    insertStmt.bind([4, "共通画像", "日向ぼっこする動物の画像"]).step();
  } finally {
    insertStmt.finalize();
  }
}

/**
 * 処理名: 公式サンプル検索実行
 * 処理概要: 指定クエリとのコサイン距離を計算し、距離昇順でソートした結果を返す。
 * @param db - SQLite データベースインスタンス。
 * @param query - 検索クエリ文字列。
 * @returns 検索結果配列。
 */
export function searchOfficialSample(db: any, query: string): Array<{ rowid: string; distance: number }> {
  const stmt = db.prepare(`
    SELECT id AS rowid, DISTANCE(embedding, embedding_query(?)) AS distance
    FROM documents
    ORDER BY DISTANCE(embedding, embedding_query(?)), id
  `);
  const results: Array<{ rowid: string; distance: number }> = [];
  try {
    stmt.bind([query, query]);
    while (stmt.step()) {
      const row = stmt.get({});
      results.push({
        rowid: String(row.rowid),
        distance: Number(row.distance)
      });
    }
    return results;
  } finally {
    stmt.finalize();
  }
}

/**
 * 処理名: 公式サンプルデータ更新・削除
 * 処理概要: id 2 の更新と id 3 の削除を同一トランザクション内で実行する。
 * @param db - SQLite データベースインスタンス。
 */
export function mutateOfficialSample(db: any): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      UPDATE documents
      SET text_data = '更新されたスポーツカー', embedding = embedding('更新されたスポーツカー')
      WHERE id = 2;
    `);
    db.exec("DELETE FROM documents WHERE id = 3;");
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // 無視
    }
    throw err;
  }
}
