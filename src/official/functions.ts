import { VectorError } from "../errors";

/**
 * 処理名: 埋め込み呼び出し要求型定義
 * 処理概要: query, document または image の推論入力パラメータを保持する型。
 * 実装理由: SQL UDF および内部推論エンジン間で統一された入力契約を提供するため。
 */
export type EmbeddingCall =
  | { operation: "query" | "document"; body: unknown; title: unknown; model?: string | undefined }
  | { operation: "image"; bytes: Uint8Array; mime: string; model?: string | undefined };

/**
 * 処理名: 埋め込み推論関数型
 * 処理概要: 埋め込み要求を受け取り、Float32 ベクトル BLOB または NULL を返すコールバック型。
 * 実装理由: UDF と推論ブリッジ間の抽象化インターフェースを定義するため。
 */
export type EmbeddingInference = (
  request: EmbeddingCall,
  budget?: unknown
) => Uint8Array | null;

const DEFAULT_ALLOWED_MODELS: ReadonlySet<string> = new Set(["embeddinggemma-2"]);

/**
 * 処理名: 第2引数モデル名検証・解決
 * 処理概要: 明示指定されたモデル名の登録確認、または省略時のコンテキスト解決を行う。
 * 実装理由: embeddingSqlValue の認知的複雑度を低減し、モデル検証を一元化するため。
 * @param args - SQL 関数引数配列。
 * @param allowedModels - 登録済みモデル集合。
 * @param resolveModel - コンテキスト解決コールバック。
 * @returns 解決されたモデル名、または undefined。
 */
function resolveTargetModel(
  args: readonly unknown[],
  allowedModels: ReadonlySet<string>,
  resolveModel?: () => string | undefined
): string | undefined {
  if (args.length < 2) {
    return resolveModel ? resolveModel() : undefined;
  }
  const model = args[1];
  if (typeof model !== "string" || !allowedModels.has(model)) {
    throw new VectorError("E_INPUT");
  }
  return model;
}

/**
 * 処理名: SQL 関数埋め込み値計算
 * 処理概要: embedding / embedding_query SQL 関数の引数を検証し、推論を実行して結果を返す。
 * 実装理由: 登録済みモデル検証を NULL および未準備状態より先に実行し、動的モデル振り分けを行うため。
 * @param name - SQL 関数名 ("embedding" または "embedding_query")。
 * @param args - SQL 関数に渡された引数配列。
 * @param infer - 推論実行コールバック (未指定時は未準備)。
 * @param allowedModels - 許可された登録済みモデル名の集合。
 * @param resolveModel - 第2引数省略時にコンテキストからモデル名を解決するコールバック。
 * @returns Float32 ベクトル BLOB、または NULL。
 */
export function embeddingSqlValue(
  name: string,
  args: readonly unknown[],
  infer?: EmbeddingInference,
  allowedModels: ReadonlySet<string> = DEFAULT_ALLOWED_MODELS,
  resolveModel?: () => string | undefined
): Uint8Array | null {
  if (args.length < 1) {
    throw new VectorError("E_INPUT");
  }

  const selectedModel = resolveTargetModel(args, allowedModels, resolveModel);
  const rawBody = args[0];
  if (rawBody === null) {
    return null;
  }
  if (typeof rawBody !== "string" || rawBody.trim().length === 0 || rawBody.includes("\0")) {
    throw new VectorError("E_INPUT");
  }
  if (!infer) {
    throw new VectorError("E_EMBEDDING_NOT_READY");
  }

  const operation: "query" | "document" =
    name === "embedding_query" ? "query" : "document";

  const includeModelField =
    selectedModel !== undefined &&
    (allowedModels !== DEFAULT_ALLOWED_MODELS || selectedModel !== "embeddinggemma-2");

  const call: EmbeddingCall = includeModelField
    ? { operation, body: rawBody, title: undefined, model: selectedModel }
    : { operation, body: rawBody, title: undefined };

  return infer(call);
}
