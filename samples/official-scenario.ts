const WARMUP_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";

/**
 * 処理名: サンプル画像バイト配列生成
 * 処理概要: ウォームアップ用の1x1 PNG画像Base64をデコードしてバイト配列として返す。
 * 実装理由: 画像埋め込みの検証に必要な固定画像バイナリを供給するため。
 * @returns 1px PNG画像のバイナリデータ。
 */
export function sampleImageBytes(): Uint8Array {
  const binary = atob(WARMUP_PNG_BASE64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * 処理名: 検索結果インターフェース
 * 処理概要: 近傍検索結果の行識別子と距離を保持する。
 * 実装理由: 検索結果行の型定義を明確にするため。
 */
export interface SampleSearchResult {
  rowid: string;
  distance: number;
}

/**
 * 処理名: 簡易ステートメントインターフェース
 * 処理概要: プリペアドステートメントの最小限の操作を定義する。
 * 実装理由: official-scenario内部でのステートメント実行を型安全に行うため。
 */
export interface ScenarioStatement {
  /**
   * 処理名: パラメータバインド
   * 処理概要: ステートメントに値をバインドする。
   * 実装理由: プレースホルダへ値を設定するため。
   * @param values - バインドするパラメータ配列。
   */
  bind(values: unknown[]): void;
  /**
   * 処理名: ステップ実行
   * 処理概要: ステートメントを1行進める。
   * 実装理由: クエリを実行するため。
   * @returns 継続可能真偽値。
   */
  step(): boolean;
  /**
   * 処理名: ステートメント終了
   * 処理概要: ステートメントハンドルを解放する。
   * 実装理由: リソースを安全に破棄するため。
   */
  finalize(): void;
}

/**
 * 処理名: 簡易データベース接続インターフェース
 * 処理概要: サンプルシナリオ実行に必要な最小限のDBメソッドを定義する。
 * 実装理由: official-scenario内部でのDB操作を型安全に行うため。
 */
export interface ScenarioDatabase {
  /**
   * 処理名: SQL実行
   * 処理概要: 指定されたSQL文字列または実行オプションでクエリを実行する。
   * 実装理由: DB初期化やデータ挿入を行うため。
   * @param sqlOrOptions - SQL文または実行設定オブジェクト。
   */
  exec(sqlOrOptions: string | { sql: string; bind?: unknown[]; rowMode?: string; callback?: (row: unknown[]) => void }): void;
  /**
   * 処理名: ステートメント準備
   * 処理概要: SQLステートメントをプリパレーションしてハンドルを返す。
   * 実装理由: パラメータバインドを伴うクエリを安全に実行するため。
   * @param sql - 準備するSQL文。
   * @returns プリペアドステートメントオブジェクト。
   */
  prepare(sql: string): ScenarioStatement;
  /**
   * 処理名: 単一値取得
   * 処理概要: クエリを実行し先頭行の第1カラムの値を返す。
   * 実装理由: カウントや設定値を簡潔に取得するため。
   * @param sql - 実行するSQL文。
   * @param bind - バインド値。
   * @returns 取得したスカラー値。
   */
  selectValue?(sql: string, bind?: unknown[]): unknown;
}

/**
 * 処理名: vec1ネイティブ検証結果
 * 処理概要: SQLiteエンジン内部におけるvec1モジュールの実在・スキーマ・実行計画の検証結果を保持する。
 * 実装理由: TSによるSQL置換・エミュレーションを排他しネイティブvec1実行を判定するため。
 */
export interface Vec1NativeVerification {
  /** 処理名: モジュール登録検証。処理概要: pragma_module_listにvec1が存在するかを保持する。実装理由: Cレベル登録を判定するため。 */
  moduleRegistered: boolean;
  /** 処理名: スキーマ保持検証。処理概要: sqlite_schemaのsqlがUSING vec1を保持するかを判定する。実装理由: テーブルすり替えを検出するため。 */
  schemaUsingVec1: boolean;
  /** 処理名: 実行計画検証。処理概要: EXPLAIN QUERY PLANにVIRTUAL TABLEが含まれるかを判定する。実装理由: 仮想テーブル走査を検証するため。 */
  queryPlanVirtualTable: boolean;
  /** 処理名: ネイティブ判定。処理概要: 全検証軸を満たしているかを保持する。実装理由: 総合的な真偽判定を行うため。 */
  isNative: boolean;
}

/**
 * 処理名: vec1ネイティブ動作検証
 * 処理概要: pragma_module_list、sqlite_schema、EXPLAIN QUERY PLANからネイティブvec1実行を検証する。
 * 実装理由: 疑似実装やSQLインターセプトによる見かけ上の動作を検出するため。
 * @param database - SQLiteデータベース接続インスタンス。
 * @returns 検証結果オブジェクト。
 */
export function verifyOfficialVec1Native(database: ScenarioDatabase): Vec1NativeVerification {
  let moduleRegistered = false;
  /**
   * 処理名: モジュール存在記録
   * 処理概要: 行が存在した際にモジュール登録フラグを真に設定する。
   * 実装理由: pragma_module_listでの検索結果を反映するため。
   */
  const onModuleRow = (): void => {
    moduleRegistered = true;
  };
  database.exec({
    sql: "SELECT 1 FROM pragma_module_list WHERE name = 'vec1';",
    rowMode: "array",
    callback: onModuleRow
  });

  let schemaUsingVec1 = false;
  /**
   * 処理名: スキーマSQL検証
   * 処理概要: 取得したSQL定義文字列にUSING vec1が含まれるかを照合する。
   * 実装理由: 仮想テーブル定義の改変を検出するため。
   * @param row - 取得行データ。
   */
  const onSchemaRow = (row: unknown[]): void => {
    schemaUsingVec1 = /USING\s+vec1/i.test(String(row[0] ?? ""));
  };
  database.exec({
    sql: "SELECT sql FROM sqlite_schema WHERE name = 'docs_vec';",
    rowMode: "array",
    callback: onSchemaRow
  });

  let queryPlanVirtualTable = false;
  /**
   * 処理名: 実行計画詳細検証
   * 処理概要: クエリプラン詳細に仮想テーブル走査の文言が含まれるかを照合する。
   * 実装理由: 仮想テーブルインデックスの適用を検出するため。
   * @param row - 取得行データ。
   */
  const onPlanRow = (row: unknown[]): void => {
    const detail = String(row[3] ?? row[row.length - 1] ?? "");
    if (/VIRTUAL\s+TABLE/i.test(detail) || /USING\s+vec1/i.test(detail)) {
      queryPlanVirtualTable = true;
    }
  };
  database.exec({
    sql: `
      EXPLAIN QUERY PLAN
      WITH q(vector) AS MATERIALIZED(SELECT embedding_query('猫'))
      SELECT c.rowid, c.distance FROM q
      CROSS JOIN docs_vec(q.vector, '{"k":4}') AS c;
    `,
    rowMode: "array",
    callback: onPlanRow
  });

  return {
    moduleRegistered,
    schemaUsingVec1,
    queryPlanVirtualTable,
    isNative: moduleRegistered && schemaUsingVec1 && queryPlanVirtualTable
  };
}

/**
 * 処理名: 公式サンプルデータ投入
 * 処理概要: 猫/車/犬の3日本語文書と共通1px PNGを登録する。
 * 実装理由: 公式サンプルシナリオに基づき検証用レコードとベクトルを投入するため。
 * @param database - SQLiteデータベース接続インスタンス。
 * @param _stage - 実行ステージ名（任意）。
 */
export async function populateOfficialSample(database: ScenarioDatabase, _stage?: string): Promise<void> {
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
 * 実装理由: ベクトル検索による距離順ソート結果を検証するため。
 * @param database - SQLiteデータベース接続インスタンス。
 * @param query - 検索クエリ文字列。
 * @returns 検索結果オブジェクトの配列。
 */
export async function searchOfficialSample(database: ScenarioDatabase, query: string): Promise<SampleSearchResult[]> {
  const results: SampleSearchResult[] = [];
  /**
   * 処理名: 検索行追加
   * 処理概要: 行配列からrowidとdistanceを抽出して結果リストに追加する。
   * 実装理由: 取得行データを型安全にパースするため。
   * @param row - 行配列。
   */
  const pushRow = (row: unknown[]): void => {
    results.push({
      rowid: String(row[0]),
      distance: Number(row[1])
    });
  };

  database.exec({
    sql: `
      WITH q(vector) AS MATERIALIZED(SELECT embedding_query(?))
      SELECT c.rowid, c.distance FROM q
      CROSS JOIN docs_vec(q.vector, '{"k":4}') AS c
      ORDER BY c.distance ASC, c.rowid ASC;
    `,
    bind: [query],
    rowMode: "array",
    callback: pushRow
  });
  return results;
}

/**
 * 処理名: 公式サンプル更新・削除
 * 処理概要: id 2を更新し、id 3を削除する（同一トランザクション）。
 * 実装理由: レコード更新および削除時のベクトルテーブル整合性を検証するため。
 * @param database - SQLiteデータベース接続インスタンス。
 */
export async function mutateOfficialSample(database: ScenarioDatabase): Promise<void> {
  database.exec(`
    BEGIN TRANSACTION;
    UPDATE docs SET body = '最新のハイブリッド車の燃費性能。' WHERE id = 2;
    UPDATE docs_vec SET embedding = gemma_embed_document('最新のハイブリッド車の燃費性能。', '車') WHERE rowid = 2;
    DELETE FROM docs WHERE id = 3;
    DELETE FROM docs_vec WHERE rowid = 3;
    COMMIT;
  `);
}
