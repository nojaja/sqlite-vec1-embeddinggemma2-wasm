import { VectorError } from "../errors";

/**
 * 処理名: 埋め込みベクトル次元数定数
 * 処理概要: EmbeddingGemma 2 の出力埋め込み次元数 (768) を定義する。
 * 実装理由: モデル仕様に基づく次元数の整合性を一貫して保証するため。
 */
export const EMBEDDING_DIMENSION = 768;

/**
 * 処理名: 埋め込みベクトルバイト長定数
 * 処理概要: 768 次元の Float32 ベクトルのバイト長 (3072 バイト) を定義する。
 * 実装理由: BLOB 格納および転送時のバイト境界検証のため。
 */
export const EMBEDDING_BYTES = 3072;

/**
 * 処理名: 最大テキストバイト長定数
 * 処理概要: 入力テキストの最大許容 UTF-8 バイト長 (1 MiB = 1048576 バイト) を定義する。
 * 実装理由: 過大なテキスト入力によるメモリ枯渇を防止するため。
 */
const MAX_TEXT_BYTES = 1024 * 1024;

/**
 * 処理名: 最大タイトル長定数
 * 処理概要: ドキュメントタイトルの最大文字長 (1024 文字) を定義する。
 * 実装理由: 長大タイトルによるプロセッサ入力異常を防ぐため。
 */
const MAX_TITLE_LENGTH = 1024;

/**
 * 処理名: トークン数制限検証
 * 処理概要: トークン数が安全な非負整数かつモデル上限 (2048) 以内であることを検証する。
 * 実装理由: モデル許容量を超えるトークンを安全に拒絶し、不正な型や数値をプロトコルエラーとするため。
 * @param count - 検証対象のトークン数。
 */
export function assertTokenLimit(count: number): void {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new VectorError("E_PROTOCOL");
  }
  if (count > 2048) {
    throw new VectorError("E_TOKEN_LIMIT");
  }
}

/**
 * 処理名: 埋め込みベクトルのBLOB変換
 * 処理概要: Float32 出力値を L2 正規化し、リトルエンディアン形式の 3072 バイト Uint8Array に変換する。
 * 実装理由: SQLite BLOB および vec1 仮想テーブルに適合する正規化バイナリを決定論的に生成するため。
 * @param values - モデルが出力した浮動小数点配列。
 * @param shape - 出力テンソルの shape。
 * @returns 3072 バイトの正規化済みバイト配列。
 */
export function embeddingToBlob(
  values: ArrayLike<number>,
  shape: readonly number[]
): Uint8Array {
  if (shape.length !== 2 || shape[0] !== 1 || shape[1] !== EMBEDDING_DIMENSION) {
    throw new VectorError("E_EMBEDDING_VALUE");
  }
  if (values.length !== EMBEDDING_DIMENSION) {
    throw new VectorError("E_EMBEDDING_VALUE");
  }

  let sumSquares = 0;
  for (let i = 0; i < EMBEDDING_DIMENSION; i++) {
    const val = values[i];
    if (!Number.isFinite(val)) {
      throw new VectorError("E_EMBEDDING_VALUE");
    }
    sumSquares += val * val;
  }

  const norm = Math.sqrt(sumSquares);
  if (!Number.isFinite(norm) || norm < 1e-12) {
    throw new VectorError("E_EMBEDDING_VALUE");
  }

  const result = new Uint8Array(EMBEDDING_BYTES);
  const view = new DataView(result.buffer, result.byteOffset, result.byteLength);
  for (let i = 0; i < EMBEDDING_DIMENSION; i++) {
    const normalized = values[i] / norm;
    view.setFloat32(i * 4, normalized, true);
  }

  return result;
}

/**
 * 処理名: テキスト文字列検証
 * 処理概要: 文字列のNUL文字、特殊トークン、UTF-8バイト長を検証する。
 * 実装理由: プロセッサへの不正トークン注入やバッファオーバーフローを防止するため。
 * @param text - 検証対象テキスト。
 * @param specialTokens - 禁止する特殊トークン一覧。
 */
function validateTextContent(text: string, specialTokens: readonly string[]): void {
  if (text.includes("\0")) {
    throw new VectorError("E_INPUT");
  }
  for (const token of specialTokens) {
    if (token.length > 0 && text.includes(token)) {
      throw new VectorError("E_INPUT");
    }
  }
  const byteLength =
    typeof Buffer !== "undefined"
      ? Buffer.byteLength(text, "utf8")
      : new TextEncoder().encode(text).length;
  if (byteLength > MAX_TEXT_BYTES) {
    throw new VectorError("E_INPUT");
  }
}

/**
 * 処理名: テキスト入力整形
 * 処理概要: query または document 操作に応じてプレフィックスを付与し、フォーマット済み文字列を生成する。
 * 実装理由: モデル仕様に合致したプロンプトを構築し、無効・危険な入力を弾くため。
 * @param operation - 操作種別 ("query" または "document")。
 * @param body - 本文入力。
 * @param title - ドキュメントタイトル (任意)。
 * @param specialTokens - トークナイザー由来の特殊トークン一覧。
 * @returns 整形された文字列、または NULL の場合 null。
 */
export function formatTextInput(
  operation: "query" | "document",
  body: unknown,
  title: unknown,
  specialTokens: readonly string[]
): string | null {
  if (body === null) {
    return null;
  }
  if (typeof body !== "string") {
    throw new VectorError("E_INPUT");
  }
  if (body.trim().length === 0) {
    throw new VectorError("E_INPUT");
  }

  validateTextContent(body, specialTokens);

  if (operation === "query") {
    return `task: search result | query: ${body}`;
  }

  if (operation === "document") {
    let resolvedTitle = "none";
    if (title !== undefined && title !== null && title !== "") {
      if (typeof title !== "string" || title.length > MAX_TITLE_LENGTH) {
        throw new VectorError("E_INPUT");
      }
      validateTextContent(title, specialTokens);
      resolvedTitle = title;
    }
    return `title: ${resolvedTitle} | text: ${body}`;
  }

  throw new VectorError("E_INPUT");
}
