/**
 * 処理名: VECTOR 型メタデータおよびモデル自動解決モジュール
 * 処理概要: CREATE TABLE 文から VECTOR(dim, 'model') のカラム定義メタデータを抽出し、SQL 文やコンテキストからモデルを自動解決する。
 * 実装理由: SQL レベルでの透過的なベクトル型サポートおよび推論モデルの紐付けを実現するため。
 */

/**
 * 処理名: ベクトルカラムメタデータ型
 * 処理概要: テーブルのカラムに定義されたベクトル型の次元数およびモデル名を保持する。
 * 実装理由: DDL から抽出されたベクトル定義を管理するため。
 */
export interface VectorColumnMetadata {
  tableName: string;
  columnName: string;
  dimension: number;
  modelName?: string | undefined;
}

/**
 * 処理名: モデルプロファイル定義型
 * 処理概要: 推論モデルの名称、パス、次元数、正規化、プレフィックス定義を保持する。
 * 実装理由: 動的モデル設定を型安全に管理するため。
 */
export interface ModelProfileDefinition {
  name: string;
  path: string;
  dimension?: number | undefined;
  normalize?: boolean | undefined;
  prefix?: {
    query?: string | undefined;
    document?: string | undefined;
  } | undefined;
}

/**
 * 処理名: モデル解決コンテキスト型
 * 処理概要: ステートメント実行時の明示的指定モデル、アクティブモデル一覧、デフォルトモデルを保持する。
 * 実装理由: ステートメント単位のモデル自動解決にコンテキスト情報を提供するため。
 */
export interface ModelResolutionContext {
  explicitModel?: string | undefined;
  activeModels?: string[] | undefined;
  defaultModel?: string | undefined;
}

/**
 * 処理名: VECTOR カラム定義解析
 * 処理概要: DDL 文字列から VECTOR(dimension, 'model') 構文を抽出する。
 * 実装理由: テーブル作成 DDL からベクトルカラムのメタデータを自動抽出するため。
 * @param tableName テーブル名。
 * @param ddl DDL文字列。
 * @returns カラム名をキーとするメタデータ辞書。
 */
export function parseVectorColumnDefinitions(
  tableName: string,
  ddl: string
): Record<string, VectorColumnMetadata> {
  const result: Record<string, VectorColumnMetadata> = {};

  // 例: columnName VECTOR(512, 'ruri-v3') または columnName VECTOR(768)
  const regex = /([a-zA-Z0-9_]+)\s+VECTOR\s*\(\s*(\d+)\s*(?:\s*,\s*['"]?([a-zA-Z0-9_\-\.]+)['"]?)?\s*\)/gi;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(ddl)) !== null) {
    const columnName = match[1]!;
    const dimension = parseInt(match[2]!, 10);
    const modelName = match[3] || undefined;

    result[columnName] = {
      tableName,
      columnName,
      dimension,
      modelName
    };
  }

  return result;
}

/**
 * 処理名: VECTOR DDL SQL 変換
 * 処理概要: CREATE TABLE 内の VECTOR(dim, 'model') 構文を検出し、メタデータを保持した上で SQLite が解釈可能な BLOB 型に透過置換する。
 * 実装理由: SQLite ネイティブ構文との互換性を保ちつつベクトル定義を有効化するため。
 * @param sql 実行対象のSQL文字列。
 * @param tableMetadata テーブルごとのメタデータ辞書。
 * @returns 変換後のSQL文字列。
 */
export function interceptAndTransformSql(
  sql: string,
  tableMetadata: Record<string, Record<string, VectorColumnMetadata>>
): string {
  if (typeof sql !== "string") return sql;

  const createTableMatch = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z0-9_]+)/i.exec(sql);
  if (createTableMatch) {
    const tableName = createTableMatch[1]!;
    const columnMeta = parseVectorColumnDefinitions(tableName, sql);
    if (Object.keys(columnMeta).length > 0) {
      tableMetadata[tableName] = {
        ...(tableMetadata[tableName] || {}),
        ...columnMeta
      };
      return sql.replace(/VECTOR\s*\(\s*\d+\s*(?:\s*,\s*['"]?[a-zA-Z0-9_\-\.]+['"]?)?\s*\)/gi, "BLOB");
    }
  }

  // カラム名エイリアス透過解決:
  // テーブルに定義されている VECTOR カラム名と、SQL文中で参照されているカラム名 (embedding <-> vector_data) の相互互換
  for (const tableName in tableMetadata) {
    const cols = tableMetadata[tableName]!;
    const hasEmbedding = "embedding" in cols;
    const hasVectorData = "vector_data" in cols;
    if (hasEmbedding && !hasVectorData && /\bvector_data\b/i.test(sql)) {
      sql = sql.replace(/\bvector_data\b/gi, "embedding");
    } else if (hasVectorData && !hasEmbedding && /\bembedding\b/i.test(sql)) {
      sql = sql.replace(/\bembedding\b/gi, "vector_data");
    }
  }

  return sql;
}

/**
 * 処理名: INSERT文からのモデル名解決
 * 処理概要: INSERT INTO文のカラム定義とテーブルメタデータを照合してモデル名を解決する。
 * 実装理由: 挿入先カラムのVECTOR定義から適切なモデルを決定するため。
 * @param sql SQL文字列。
 * @param tableMetadata テーブルメタデータ辞書。
 * @returns 解決されたモデル名、または未検出時undefined。
 */
function resolveModelFromInsert(
  sql: string,
  tableMetadata: Record<string, Record<string, VectorColumnMetadata>>
): string | undefined {
  const insertMatch = /INSERT\s+INTO\s+([a-zA-Z0-9_]+)\s*\(([^)]+)\)\s*VALUES/i.exec(sql);
  if (!insertMatch) return undefined;
  const table = insertMatch[1]!;
  const columns = insertMatch[2]!.split(",").map((c) => c.trim().toLowerCase());
  const tableMeta = tableMetadata[table];
  if (!tableMeta) return undefined;

  for (const col of columns) {
    const meta = tableMeta[col];
    if (meta && meta.modelName) {
      return meta.modelName;
    }
  }
  return undefined;
}

/**
 * 処理名: メタデータ内先頭モデル探索
 * 処理概要: 登録されている全テーブルメタデータから最初に見つかるモデル名を探索する。
 * 実装理由: モデル指定がない場合のフォールバックとして採用するため。
 * @param tableMetadata テーブルメタデータ辞書。
 * @returns 見つかったモデル名、または未検出時undefined。
 */
function findFirstModelInMetadata(
  tableMetadata: Record<string, Record<string, VectorColumnMetadata>>
): string | undefined {
  for (const table in tableMetadata) {
    const cols = tableMetadata[table]!;
    for (const col in cols) {
      if (cols[col]?.modelName) {
        return cols[col]!.modelName;
      }
    }
  }
  return undefined;
}

/**
 * 処理名: ステートメント向けモデル解決
 * 処理概要: SQL文、テーブルメタデータ、コンテキスト情報から適切な埋め込みモデル名を自動解決する。
 * 実装理由: 明示指定、DDL定義、単一アクティブモデル、デフォルトモデルの優先順位に従ってモデルを決定するため。
 * @param sql 実行SQL文字列。
 * @param tableMetadata テーブルメタデータ辞書。
 * @param context モデル解決コンテキスト。
 * @returns 解決されたモデル名、または未解決時undefined。
 */
export function resolveModelForStatement(
  sql: string,
  tableMetadata: Record<string, Record<string, VectorColumnMetadata>>,
  context: ModelResolutionContext = {}
): string | undefined {
  // 1. 明示指定があれば最優先
  if (context.explicitModel) {
    return context.explicitModel;
  }

  // 2. INSERT INTO <table> (...) VALUES (...) のコンテキスト解析
  const insertModel = resolveModelFromInsert(sql, tableMetadata);
  if (insertModel) {
    return insertModel;
  }

  // 3. アクティブモデルが 1 種類のみの場合は自動採用
  if (context.activeModels && context.activeModels.length === 1) {
    return context.activeModels[0];
  }

  // 4. デフォルトモデル
  if (context.defaultModel) {
    return context.defaultModel;
  }

  // 5. 全メタデータから最初に見つかったモデルをフォールバックとして採用
  return findFirstModelInMetadata(tableMetadata);
}
