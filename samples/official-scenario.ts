const WARMUP_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";

export function sampleImageBytes(): Uint8Array {
  const binary = atob(WARMUP_PNG_BASE64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export interface SampleSearchResult {
  rowid: string;
  distance: number;
}

/**
 * 処理名: 公式サンプルデータ投入
 * 処理概要: 猫/車/犬の3日本語文書と共通1px PNGを登録する。
 */
export async function populateOfficialSample(database: any, _stage?: string): Promise<void> {
  database.exec(`
    CREATE TABLE IF NOT EXISTS docs (
      id INTEGER PRIMARY KEY,
      title TEXT,
      body TEXT
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS docs_vec USING vec1(embedding);
    INSERT INTO docs_vec(cmd,arg) VALUES('rebuild','{"index":"flat","distance":"cos"}');
  `);

  const pngBytes = sampleImageBytes();

  // id 1: 猫
  database.exec({
    sql: `
      INSERT INTO docs(id, title, body) VALUES(1, '猫', 'かわいい猫の写真や記事です。');
      INSERT INTO docs_vec(rowid, embedding) VALUES(1, gemma_embed_document('かわいい猫の写真や記事です。', '猫'));
    `
  });

  // id 2: 車
  database.exec({
    sql: `
      INSERT INTO docs(id, title, body) VALUES(2, '車', '最新の電気自動車の性能と特徴。');
      INSERT INTO docs_vec(rowid, embedding) VALUES(2, gemma_embed_document('最新の電気自動車の性能と特徴。', '車'));
    `
  });

  // id 3: 犬
  database.exec({
    sql: `
      INSERT INTO docs(id, title, body) VALUES(3, '犬', '忠実な犬の飼い方とトレーニング。');
      INSERT INTO docs_vec(rowid, embedding) VALUES(3, gemma_embed_document('忠実な犬の飼い方とトレーニング。', '犬'));
    `
  });

  // id 4: 1px PNG画像
  database.exec({
    sql: "INSERT INTO docs(id, title, body) VALUES(4, '画像', '共通1px PNG画像');"
  });
  const stmt = database.prepare("INSERT INTO docs_vec(rowid, embedding) VALUES(4, gemma_embed_image(?, 'image/png'))");
  try {
    stmt.bind([pngBytes]);
    stmt.step();
  } finally {
    stmt.finalize();
  }
}

/**
 * 処理名: 公式サンプル検索
 * 処理概要: クエリベクトルから最近傍検索を行い結果を返す。
 */
export async function searchOfficialSample(database: any, query: string): Promise<SampleSearchResult[]> {
  const results: SampleSearchResult[] = [];
  database.exec({
    sql: `
      WITH q(vector) AS MATERIALIZED(SELECT embedding_query(?))
      SELECT c.rowid, c.distance FROM q
      CROSS JOIN docs_vec(q.vector, '{"k":4}') AS c
      ORDER BY c.distance ASC, c.rowid ASC;
    `,
    bind: [query],
    rowMode: "array",
    callback: (row: any[]) => {
      results.push({
        rowid: String(row[0]),
        distance: Number(row[1])
      });
    }
  });
  return results;
}

/**
 * 処理名: 公式サンプル更新・削除
 * 処理概要: id 2を更新し、id 3を削除する（同一トランザクション）。
 */
export async function mutateOfficialSample(database: any): Promise<void> {
  database.exec(`
    BEGIN TRANSACTION;
    UPDATE docs SET body = '最新のハイブリッド車の燃費性能。' WHERE id = 2;
    UPDATE docs_vec SET embedding = gemma_embed_document('最新のハイブリッド車の燃費性能。', '車') WHERE rowid = 2;
    DELETE FROM docs WHERE id = 3;
    DELETE FROM docs_vec WHERE rowid = 3;
    COMMIT;
  `);
}
