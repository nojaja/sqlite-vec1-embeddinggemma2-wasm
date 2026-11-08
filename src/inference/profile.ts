import { VectorError } from "../errors";

/** 埋め込み次元数。 */
export const EMBEDDING_DIMENSION = 768;
/** 埋め込みBLOBのbyte数。 */
export const EMBEDDING_BYTES = 3072;
const MAX_TOKENS = 2048;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_TITLE_BYTES = 1024;

/**
 * 処理名: token上限検証
 * 処理概要: 最終token数が非負safe integerで2048以下かを確認する。
 * 実装理由: 自動切詰めで上限超過を隠さないため。
 * @param count - 最終token数。
 */
export function assertTokenLimit(count: number): void {
  if (!Number.isSafeInteger(count) || count < 0) throw new VectorError("E_PROTOCOL");
  if (count > MAX_TOKENS) throw new VectorError("E_TOKEN_LIMIT");
}

/**
 * 処理名: embedding BLOB変換
 * 処理概要: shapeと値を検証しFloat64のL2正規化後にLE Float32へ格納する。
 * 実装理由: vec1へ正規化済み768次元BLOBだけを渡すため。
 * @param values - モデル出力の要素。
 * @param shape - tensor shape。
 * @returns 独立所有の3072 byte BLOB。
 */
export function embeddingToBlob(values: ArrayLike<number>, shape: readonly number[]): Uint8Array {
  if (shape.length !== 2 || shape[0] !== 1 || shape[1] !== EMBEDDING_DIMENSION || values.length !== EMBEDDING_DIMENSION) {
    throw new VectorError("E_EMBEDDING_VALUE");
  }
  let squared = 0;
  for (let index = 0; index < EMBEDDING_DIMENSION; index += 1) {
    const value = values[index] as number;
    if (!Number.isFinite(value)) throw new VectorError("E_EMBEDDING_VALUE");
    squared += value * value;
  }
  const norm = Math.sqrt(squared);
  if (!Number.isFinite(norm) || norm <= 1e-12) throw new VectorError("E_EMBEDDING_VALUE");
  const result = new Uint8Array(EMBEDDING_BYTES);
  const view = new DataView(result.buffer);
  for (let index = 0; index < EMBEDDING_DIMENSION; index += 1) view.setFloat32(index * 4, (values[index] as number) / norm, true);
  return result;
}

/**
 * 処理名: UTF-8長取得
 * 処理概要: 文字列のUTF-8 byte長を返す。
 * 実装理由: 本文とtitleの上限をbyteで検証するため。
 * @param text - 対象文字列。
 * @returns byte長。
 */
function utf8Length(text: string): number {
  if (typeof Buffer !== "undefined" && typeof Buffer.byteLength === "function") {
    return Buffer.byteLength(text, "utf8");
  }
  return new TextEncoder().encode(text).length;
}

/**
 * 処理名: 文字列入力検証
 * 処理概要: 型、NUL、special token、UTF-8上限を確認する。
 * 実装理由: processorへ暗黙変換や想定外tokenを渡さないため。
 * @param value - 検査値。
 * @param limit - byte上限。
 * @param tokens - special token。
 * @returns 検証済み文字列。
 */
function checkedString(value: unknown, limit: number, tokens: readonly string[]): string {
  if (typeof value !== "string" || value.includes("\0") || utf8Length(value) > limit) throw new VectorError("E_INPUT");
  for (const token of tokens) if (token.length > 0 && value.includes(token)) throw new VectorError("E_INPUT");
  return value;
}

/**
 * 処理名: text入力整形
 * 処理概要: query/document prefixを付与する。NULL本文はnullを返す。
 * 実装理由: taskに応じた固定prefixを一箇所で保証するため。
 * @param operation - query/document。
 * @param body - 本文。
 * @param title - 文書title。
 * @param specialTokens - tokenizer由来special token。
 * @returns 整形文字列またはnull。
 */
export function formatTextInput(operation: "query" | "document", body: unknown, title: unknown, specialTokens: readonly string[]): string | null {
  if (body === null) return null;
  const text = checkedString(body, MAX_BODY_BYTES, specialTokens);
  if (text.trim().length === 0) throw new VectorError("E_INPUT");
  if (operation === "query") return `task: search result | query: ${text}`;
  const name = title === undefined || title === null || title === "" ? "none" : checkedString(title, MAX_TITLE_BYTES, specialTokens);
  return `title: ${name} | text: ${text}`;
}
