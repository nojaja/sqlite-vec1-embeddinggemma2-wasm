/**
 * 処理名: エラーコード定義
 * 処理概要: 製品全体で使用される固定のエラー識別子を定義する。
 * 実装理由: 内部・外部境界で一貫したエラーハンドリングと型安全性を確保するため。
 */
export type ErrorCode =
  | "E_INPUT"
  | "E_TOKEN_LIMIT"
  | "E_IMAGE_FORMAT"
  | "E_IMAGE_LIMIT"
  | "E_EMBEDDING_NOT_READY"
  | "E_EMBEDDING_VALUE"
  | "E_INFERENCE"
  | "E_MEMORY"
  | "E_PROTOCOL"
  | "E_TIMEOUT"
  | "E_CANCELLED"
  | "E_ASSET_INTEGRITY"
  | "E_MODEL_CACHE_MISS"
  | "E_MODEL_MISMATCH"
  | "E_MODEL_UNBOUND"
  | "E_ENVIRONMENT"
  | "E_DB_IN_USE"
  | "E_DATABASE_LOCKED"
  | "E_STORAGE"
  | "E_OUTCOME_UNKNOWN";

/**
 * 処理名: 製品固有エラークラス
 * 処理概要: 固定のエラーコードを保持するErrorサブクラスを提供する。
 * 実装理由: エラーコード文字列のみをメッセージとして保持し、機密情報の漏洩を防ぎつつ決定論的なエラー処理を行うため。
 */
export class VectorError extends Error {
  public readonly code: ErrorCode;

  /**
   * 処理名: VectorErrorコンストラクタ
   * 処理概要: エラーコードを受け取り、nameをVectorError、messageをcodeに設定して初期化する。
   * 実装理由: 仕様に定められたエラーコード形式（messageとcodeが同一）を厳格に保持するため。
   * @param code - 設定するエラーコード。
   */
  constructor(code: ErrorCode) {
    super(code);
    this.name = "VectorError";
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
