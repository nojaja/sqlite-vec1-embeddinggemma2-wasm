/** 製品が公開する固定エラーcode。 */
export type ErrorCode =
  | "E_INPUT" | "E_TOKEN_LIMIT" | "E_IMAGE_FORMAT" | "E_IMAGE_LIMIT" | "E_EMBEDDING_NOT_READY"
  | "E_EMBEDDING_VALUE" | "E_INFERENCE" | "E_MEMORY" | "E_PROTOCOL" | "E_TIMEOUT" | "E_CANCELLED"
  | "E_ASSET_INTEGRITY" | "E_MODEL_CACHE_MISS" | "E_MODEL_MISMATCH" | "E_MODEL_UNBOUND"
  | "E_ENVIRONMENT" | "E_DB_IN_USE" | "E_DATABASE_LOCKED" | "E_STORAGE" | "E_OUTCOME_UNKNOWN";

/**
 * 処理名: 製品エラー
 * 処理概要: messageと読取り専用codeが固定code文字列だけのErrorを表す。
 * 実装理由: 外部例外本文を利用者へ漏らさないため。
 */
export class VectorError extends Error {
  public readonly code: ErrorCode;

  /**
   * 処理名: 製品エラー生成
   * 処理概要: code文字列をmessageとnameへ設定する。
   * 実装理由: 呼出し側が固定codeだけで分岐できるようにするため。
   * @param code - 固定エラーcode。
   */
  public constructor(code: ErrorCode) {
    super(code);
    this.name = "VectorError";
    this.code = code;
  }
}
