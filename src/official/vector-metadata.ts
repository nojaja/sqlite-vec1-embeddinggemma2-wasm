/**
 * 処理名: VECTOR 型メタデータおよびモデル自動解決モジュール
 * 処理概要:
 * 1. CREATE TABLE 文から VECTOR(dim, 'model') のカラム定義メタデータを抽出する (方式A)
 * 2. 実行時 SQL ステートメントおよびアクティブモデル一覧から [model] を自動解決する
 * 3. 動的モデルプロファイル型を定義する
 */

export interface VectorColumnMetadata {
  tableName: string;
  columnName: string;
  dimension: number;
  modelName?: string | undefined;
}

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

export interface ModelResolutionContext {
  explicitModel?: string | undefined;
  activeModels?: string[] | undefined;
  defaultModel?: string | undefined;
}

/**
 * 処理名: VECTOR カラム定義解析
 * 処理概要: DDL 文字列から VECTOR(dimension, 'model') 構文を抽出する。
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
 * 処理概要: CREATE TABLE 内の VECTOR(dim, 'model') 構文を検出し、
 * メタデータを保持した上で SQLite がネイティブに解釈可能な BLOB 型に透過置換する。
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
 * 処理名: ステートメント向けモデル解決
 * 処理概要:
 * 優先順位:
 * 1. 明示指定 (explicitModel)
 * 2. INSERT / UPDATE の代入先カラムの VECTOR 定義
 * 3. 単一アクティブモデル
 * 4. デフォルトモデル
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
  const insertMatch = /INSERT\s+INTO\s+([a-zA-Z0-9_]+)\s*\(([^)]+)\)\s*VALUES/i.exec(sql);
  if (insertMatch) {
    const table = insertMatch[1]!;
    const columns = insertMatch[2]!.split(",").map((c) => c.trim().toLowerCase());
    const tableMeta = tableMetadata[table];

    if (tableMeta) {
      for (const col of columns) {
        const meta = tableMeta[col];
        if (meta && meta.modelName) {
          return meta.modelName;
        }
      }
    }
  }

  // 3. アクティブモデルが 1 種類のみの場合は自動採用
  if (context.activeModels && context.activeModels.length === 1) {
    return context.activeModels[0];
  }

  // 4. デフォルトモデル
  if (context.defaultModel) {
    return context.defaultModel;
  }

  // 全メタデータから最初に見つかったモデルをフォールバックとして採用
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
