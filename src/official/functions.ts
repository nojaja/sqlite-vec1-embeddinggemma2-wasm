import { VectorError } from "../errors";

/**
 * 処理名: 埋め込み呼び出し要求型定義
 * 処理概要: query, document または image の推論入力パラメータを保持する型。
 * 実装理由: SQL UDF および内部推論エンジン間で統一された入力契約を提供するため。
 */
export type EmbeddingCall =
  | { operation: "query" | "document"; body: unknown; title: unknown }
  | { operation: "image"; bytes: Uint8Array; mime: string };

/**
 * 処理名: 埋め込み推論関数型
 * 処理概要: 埋め込み要求を受け取り、Float32 ベクトル BLOB または NULL を返すコールバック型。
 * 実装理由: UDF と推論ブリッジ間の抽象化インターフェースを定義するため。
 */
export type EmbeddingInference = (
  request: EmbeddingCall,
  budget?: unknown
) => Uint8Array | null;

/**
 * 処理名: SQL 関数埋め込み値計算
 * 処理概要: embedding / embedding_query SQL 関数の引数を検証し、推論を実行して結果を返す。
 * 実装理由: generic model 検証を NULL および未準備状態より先に実行し、厳格な SQL UDF 契約を満たすため。
 * @param name - SQL 関数名 ("embedding" または "embedding_query")。
 * @param args - SQL 関数に渡された引数配列。
 * @param infer - 推論実行コールバック (未指定時は未準備)。
 * @returns 3072 バイトの Float32 ベクトル BLOB、または NULL。
 */
export function embeddingSqlValue(
  name: string,
  args: readonly unknown[],
  infer?: EmbeddingInference
): Uint8Array | null {
  if (args.length < 1) {
    throw new VectorError("E_INPUT");
  }

  // 第2引数 [model] の検証（NULL および準備状態より最優先）
  if (args.length >= 2) {
    const model = args[1];
    if (typeof model !== "string" || model !== "embeddinggemma-2") {
      throw new VectorError("E_INPUT");
    }
  }

  const rawBody = args[0];
  if (rawBody === null) {
    return null;
  }

  if (typeof rawBody !== "string") {
    throw new VectorError("E_INPUT");
  }
  if (rawBody.trim().length === 0 || rawBody.includes("\0")) {
    throw new VectorError("E_INPUT");
  }

  if (!infer) {
    throw new VectorError("E_EMBEDDING_NOT_READY");
  }

  const operation: "query" | "document" =
    name === "embedding_query" ? "query" : "document";

  return infer({
    operation,
    body: rawBody,
    title: undefined
  });
}
