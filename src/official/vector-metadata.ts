import { VectorError } from "../errors";

/**
 * 処理名: テーブル列情報行インターフェース
 * 処理概要: PRAGMA table_info の 1 行の構造を表す。
 */
export interface TableColumnInfoRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

/**
 * 処理名: VECTOR 列メタデータインターフェース
 */
export interface VectorColumnMetadata {
  tableName: string;
  columnName: string;
  dimension: number;
  modelName?: string;
}

/**
 * 処理名: モデルプロファイル定義インターフェース
 */
export interface ModelProfileDefinition {
  name: string;
  path: string;
  dimension: number;
  normalize?: boolean;
  prefix?: {
    query?: string;
    document?: string;
  };
}

/**
 * 処理名: Authorizer 通知インターフェース
 */
export interface AuthorizerNotification {
  actionCode: number;
  arg1?: string;
  arg2?: string;
  arg3?: string;
  arg4?: string;
}

/**
 * 処理名: モデル解決オプションインターフェース
 */
export interface ModelResolutionOptions {
  explicitModel?: string;
  defaultModel?: string;
  activeModels?: string[];
}

/**
 * 処理名: VECTOR 型宣言パース
 * 処理概要: 型宣言文字列から次元数および任意のモデル名を抽出する。
 * 実装理由: Lemon パーサーが受け入れた VECTOR(dimension, 'model') 等の宣言型からスキーマ情報を取得するため。
 * @param typeStr - 型宣言文字列。
 * @returns 次元数およびモデル名、またはパース不能な場合は null。
 */
export function parseVectorTypeDeclaration(
  typeStr: string
): { dimension: number; modelName?: string } | null {
  if (typeof typeStr !== "string") return null;

  const match = typeStr.match(/^VECTOR\s*\(\s*(-?\d+)\s*(?:,\s*['"]?([a-zA-Z0-9_\-.]+)['"]?\s*)?\)$/i);
  if (!match) return null;

  const dim = parseInt(match[1]!, 10);
  if (isNaN(dim) || dim <= 0) return null;

  const modelName = match[2];
  return {
    dimension: dim,
    modelName: modelName !== undefined ? modelName : undefined
  };
}

/**
 * 処理名: PRAGMA table_info からの VECTOR 列メタデータ抽出
 * 処理概要: PRAGMA table_info の全行から VECTOR 型のカラムのみを抽出し、メタデータ辞書を構築する。
 * @param tableName - 対象テーブル名。
 * @param pragmaRows - PRAGMA table_info の行配列。
 * @returns カラム名をキーとする VectorColumnMetadata 辞書。
 */
export function extractVectorColumnsFromTableInfo(
  tableName: string,
  pragmaRows: TableColumnInfoRow[]
): Record<string, VectorColumnMetadata> {
  const result: Record<string, VectorColumnMetadata> = {};

  for (const row of pragmaRows) {
    const parsed = parseVectorTypeDeclaration(row.type);
    if (parsed) {
      result[row.name] = {
        tableName,
        columnName: row.name,
        dimension: parsed.dimension,
        modelName: parsed.modelName
      };
    }
  }

  return result;
}

/**
 * 処理名: Authorizer 通知およびコンテキストからのモデル自動解決
 * 処理概要: 優先順位 (1.明示的指定, 2.代入先カラム, 3.単一アクティブモデル, 4.デフォルトモデル) に従って推論モデルを解決する。
 * 実装理由: SQL 関数呼び出し時にモデル引数が省略された場合でも、安全かつ決定論的に対象モデルを特定するため。
 * @param notifications - クエリ実行中に Authorizer が受け取った通知配列。
 * @param tableMetadata - テーブル別 VECTOR 列メタデータ辞書。
 * @param options - モデル解決オプション。
 * @param context - 任意の実行コンテキスト (テーブル名・カラム名)。
 * @returns 解決されたモデル名。
 */
export function resolveModelFromAuthorizer(
  notifications: AuthorizerNotification[],
  tableMetadata: Record<string, Record<string, VectorColumnMetadata>>,
  options: ModelResolutionOptions,
  context?: { tableName?: string; columnName?: string }
): string {
  // 1. Explicit [model] parameter always takes highest precedence
  if (options.explicitModel) {
    return options.explicitModel;
  }

  // 2. Destination column context (context または Authorizer 通知から解決)
  if (context?.tableName && context?.columnName) {
    const meta = tableMetadata[context.tableName]?.[context.columnName];
    if (meta?.modelName) {
      return meta.modelName;
    }
  }

  // Authorizer notification sequence からの検索 (SQLITE_UPDATE: 9, SQLITE_INSERT: 18)
  for (const n of notifications) {
    if (n.actionCode === 9 && n.arg1 && n.arg2) {
      const meta = tableMetadata[n.arg1]?.[n.arg2];
      if (meta?.modelName) {
        return meta.modelName;
      }
    }
  }

  // 3. Resolves model from single active model in DB when column context is absent
  if (options.activeModels && options.activeModels.length === 1 && options.activeModels[0]) {
    return options.activeModels[0];
  }

  // 4. Fallbacks to defaultModel when DB has multiple models and context is ambiguous
  if (options.defaultModel) {
    return options.defaultModel;
  }

  // 5. Throws E_MODEL_UNBOUND when resolution cannot be determined safely
  throw new VectorError("E_MODEL_UNBOUND");
}

/**
 * 処理名: 参照モデルネットワークポリシー評価
 * 処理概要: ネットワーク許可設定とキャッシュ有無に基づいて "fetch" または "cache" を判定する。
 * 実装理由: オフラインモードでの意図せぬ外部通信を遮断し、キャッシュミスを即座にエラー化するため。
 * @param policy - ネットワークポリシー ("allow" または "offline")。
 * @param isCached - キャッシュが存在するかどうか。
 * @returns "fetch" または "cache"。
 */
export function evaluateReferenceModelNetworkPolicy(
  policy: "allow" | "offline",
  isCached: boolean
): "fetch" | "cache" {
  if (policy !== "allow" && policy !== "offline") {
    throw new VectorError("E_INPUT");
  }

  if (policy === "allow") {
    return isCached ? "cache" : "fetch";
  }

  // offline
  if (isCached) {
    return "cache";
  }
  throw new VectorError("E_MODEL_CACHE_MISS");
}

/**
 * 処理名: コサイン距離計算 (DISTANCE UDF)
 * 処理概要: 2 つの float32 ベクトルバイナリから 1.0 - コサイン類似度 を計算する。
 * 実装理由: 柔軟な次元数 (256, 512, 768 等) に対応し、直交時 1.0、逆向き時 2.0、同一時 0.0 を正確に算出するため。
 * @param a - 第 1 ベクトル (Uint8Array または null)。
 * @param b - 第 2 ベクトル (Uint8Array または null)。
 * @returns コサイン距離 (0.0〜2.0)、またはオペランドが null の場合は null。
 */
export function calculateCosineDistance(
  a: unknown,
  b: unknown
): number | null {
  if (a === null || b === null) {
    return null;
  }

  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) {
    throw new VectorError("E_INPUT");
  }

  if (a.byteLength % 4 !== 0 || b.byteLength % 4 !== 0) {
    throw new VectorError("E_INPUT");
  }

  if (a.byteLength !== b.byteLength || a.byteLength === 0) {
    throw new VectorError("E_INPUT");
  }

  const len = a.byteLength / 4;
  const viewA = new DataView(a.buffer, a.byteOffset, a.byteLength);
  const viewB = new DataView(b.buffer, b.byteOffset, b.byteLength);

  let dot = 0;
  let normASq = 0;
  let normBSq = 0;

  for (let i = 0; i < len; i++) {
    const valA = viewA.getFloat32(i * 4, true);
    const valB = viewB.getFloat32(i * 4, true);

    if (!Number.isFinite(valA) || !Number.isFinite(valB) || Number.isNaN(valA) || Number.isNaN(valB)) {
      throw new VectorError("E_INPUT");
    }

    dot += valA * valB;
    normASq += valA * valA;
    normBSq += valB * valB;
  }

  if (normASq <= 0 || normBSq <= 0) {
    throw new VectorError("E_INPUT");
  }

  const normA = Math.sqrt(normASq);
  const normB = Math.sqrt(normBSq);
  let cosSim = dot / (normA * normB);

  // 数値誤差クランプ
  if (cosSim > 1.0) cosSim = 1.0;
  if (cosSim < -1.0) cosSim = -1.0;

  return 1.0 - cosSim;
}
