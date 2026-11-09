import { VectorError } from "../errors";
import type { EmbeddingCall, EmbeddingInference } from "../inference/statement-embedding-cache";
import { formatTextInput } from "../inference/profile";

export { type EmbeddingCall, type EmbeddingInference };

/**
 * 処理名: 汎用埋め込みUDF処理
 * 処理概要: embeddingおよびembedding_query関数の引数を検証し推論結果を返す。
 * 実装理由: 標準UDF呼び出しを処理するため。
 * @param name - 関数名。
 * @param args - 引数配列。
 * @param infer - 推論関数。
 * @returns 埋め込みBLOBまたはnull。
 */
function handleEmbedding(
  name: string,
  args: readonly unknown[],
  infer?: EmbeddingInference
): Uint8Array | null {
  if (args.length >= 2) {
    const model = args[1];
    if (model !== "embeddinggemma-2" && model !== "ruri-v3") {
      throw new VectorError("E_INPUT");
    }
  }
  const body = args[0];
  if (body === null) return null;
  if (typeof body !== "string") throw new VectorError("E_INPUT");
  formatTextInput("query", body, undefined, []);
  if (!infer) throw new VectorError("E_EMBEDDING_NOT_READY");
  const operation = name === "embedding" ? "document" : "query";
  return infer({ operation, body, title: undefined });
}

/**
 * 処理名: Gemmaクエリ埋め込みUDF処理
 * 処理概要: gemma_embed_query関数の引数を検証し推論結果を返す。
 * 実装理由: クエリ専用埋め込みUDFを処理するため。
 * @param args - 引数配列。
 * @param infer - 推論関数。
 * @returns 埋め込みBLOBまたはnull。
 */
function handleGemmaQuery(
  args: readonly unknown[],
  infer?: EmbeddingInference
): Uint8Array | null {
  const body = args[0];
  if (body === null) return null;
  if (typeof body !== "string") throw new VectorError("E_INPUT");
  formatTextInput("query", body, undefined, []);
  if (!infer) throw new VectorError("E_EMBEDDING_NOT_READY");
  return infer({ operation: "query", body, title: undefined });
}

/**
 * 処理名: Gemma文書埋め込みUDF処理
 * 処理概要: gemma_embed_document関数の引数を検証し推論結果を返す。
 * 実装理由: 文書専用埋め込みUDFを処理するため。
 * @param args - 引数配列。
 * @param infer - 推論関数。
 * @returns 埋め込みBLOBまたはnull。
 */
function handleGemmaDocument(
  args: readonly unknown[],
  infer?: EmbeddingInference
): Uint8Array | null {
  const body = args[0];
  if (body === null) return null;
  if (typeof body !== "string") throw new VectorError("E_INPUT");
  const title = args[1];
  formatTextInput("document", body, title, []);
  if (!infer) throw new VectorError("E_EMBEDDING_NOT_READY");
  return infer({ operation: "document", body, title });
}

/**
 * 処理名: Gemma画像埋め込みUDF処理
 * 処理概要: gemma_embed_image関数の引数を検証し画像推論結果を返す。
 * 実装理由: 画像埋め込みUDFを処理するため。
 * @param args - 引数配列。
 * @param infer - 推論関数。
 * @returns 埋め込みBLOB。
 */
function handleGemmaImage(
  args: readonly unknown[],
  infer?: EmbeddingInference
): Uint8Array {
  const bytes = args[0];
  const mime = args[1];
  if (!(bytes instanceof Uint8Array) || typeof mime !== "string") {
    throw new VectorError("E_INPUT");
  }
  if (!infer) throw new VectorError("E_EMBEDDING_NOT_READY");
  return infer({ operation: "image", bytes, mime });
}

/**
 * 処理名: 埋め込みSQL関数評価
 * 処理概要: 各種埋め込みUDFの引数を検証し推論関数を呼び出してベクトルBLOBを返す。
 * 実装理由: SQLite SQL実行コンテキストから統一的に埋め込み推論を実行するため。
 * @param name - 関数名。
 * @param args - 引数配列。
 * @param infer - 推論実行関数（任意）。
 * @returns 埋め込みバイナリまたはnull。
 */
export function embeddingSqlValue(
  name: string,
  args: readonly unknown[],
  infer?: EmbeddingInference
): Uint8Array | null {
  switch (name) {
    case "embedding":
    case "embedding_query":
      return handleEmbedding(name, args, infer);
    case "gemma_embed_query":
      return handleGemmaQuery(args, infer);
    case "gemma_embed_document":
      return handleGemmaDocument(args, infer);
    case "gemma_embed_image":
      return handleGemmaImage(args, infer);
    default:
      throw new VectorError("E_INPUT");
  }
}
