import type { EmbeddingOptions, ReadyEmbeddingOptions } from "./options";
import type { EmbeddingCacheIdentity, EmbeddingInference } from "../inference/statement-embedding-cache";

/**
 * 処理名: 埋め込み拡張制御インターフェース
 * 処理概要: 登録された埋め込み機能の終了処理を提供する。
 * 実装理由: データベース終了時に推論リソースを安全に解放するため。
 */
export interface EmbeddingControl {
  /**
   * 処理名: 埋め込み拡張解放
   * 処理概要: セッションおよびリソースを破棄する。
   * 実装理由: リークを防ぎ安全に終了するため。
   */
  close(): Promise<void>;
}

/**
 * 処理名: SQLite3静的オブジェクト型
 * 処理概要: SQLite Wasmランタイムの公開オブジェクト構造を定義する。
 * 実装理由: 公式SQLite Wasmランタイムとの互換性を保つため。
 */
export interface Sqlite3Static {
  /**
   * 処理名: OO1名前空間
   * 処理概要: オブジェクト指向データベースクラス群を提供する。
   * 実装理由: 公式OO1インターフェースを提供するため。
   */
  oo1: {
    /** データベースクラス */
    DB: any;
    /** OPFSデータベースクラス */
    OpfsDb?: any;
  };
  /** C-APIオブジェクト */
  capi: any;
  /** Wasmインスタンスメタ情報 */
  wasm: any;
  /**
   * 処理名: OPFS SAH Pool VFSインストール
   * 処理概要: OPFS同期アクセスコントロールプールVFSを登録する。
   * 実装理由: 高速な永続化ストレージを提供するため。
   */
  installOpfsSAHPoolVfs?(options?: any): Promise<any>;
  [key: string]: any;
}

/**
 * 処理名: 製品SQLite3型
 * 処理概要: 公式SQLite3ランタイムに埋め込み拡張制御を付与した製品型。
 * 実装理由: 利用者に公式機能と埋め込み制御の両方を提供するため。
 */
export type ProductSqlite3 = Sqlite3Static & {
  /** 埋め込み拡張制御オブジェクト */
  embedding: EmbeddingControl;
};

/**
 * 処理名: 製品初期化オプション型
 * 処理概要: SQLiteランタイムおよび埋め込み機能の初期化設定を定義する。
 * 実装理由: 柔軟な初期化設定を可能にするため。
 */
export type ProductInitOptions = Record<string, unknown> & {
  /** 埋め込みオプション */
  embedding?: EmbeddingOptions | undefined;
};

/**
 * 処理名: 公式ファクトリ型
 * 処理概要: SQLite公式モジュールの初期化関数型。
 * 実装理由: ファクトリ関数を抽象化するため。
 */
export type OfficialFactory = (options?: Record<string, unknown>) => Promise<Sqlite3Static>;

/**
 * 処理名: 公式推論セッション
 * 処理概要: 実行時推論セッションのインターフェース。
 * 実装理由: 推論実行とメタデータを管理するため。
 */
export interface OfficialInferenceSession {
  /** 推論関数 */
  infer: EmbeddingInference;
  /** キャッシュ同一性 */
  identity: EmbeddingCacheIdentity;
  /** 付随情報 */
  information: Record<string, unknown>;
  /**
   * 処理名: 準備完了確認
   * 処理概要: セッションが推論可能な状態か確認する。
   * 実装理由: 未初期化状態での推論実行を防ぐため。
   */
  assertReady?(): void;
  /**
   * 処理名: セッション終了
   * 処理概要: 推論セッションのリソースを解放する。
   * 実装理由: メモリリークを防ぐため。
   */
  close(): Promise<void>;
}

/**
 * 処理名: 公式推論ファクトリ型
 * 処理概要: 検証済みオプションから推論セッションを生成する関数型。
 * 実装理由: 推論セッションの生成処理を分離するため。
 */
export type OfficialInferenceFactory = (
  options: ReadyEmbeddingOptions,
  extra?: any
) => Promise<OfficialInferenceSession>;
