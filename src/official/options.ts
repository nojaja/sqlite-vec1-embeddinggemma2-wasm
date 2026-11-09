import { VectorError } from "../errors";

/**
 * 処理名: 推論バックエンド種別
 * 処理概要: サポートされる推論バックエンド一覧。
 * 実装理由: 実行環境に応じた最適なアクセラレータを選択するため。
 */
export type Backend = "wasm" | "webgpu" | "directml";

/**
 * 処理名: モデル取得設定
 * 処理概要: モデル資材の取得元やネットワーク利用ポリシーを定義する。
 * 実装理由: オンライン/オフライン動作を制御するため。
 */
export interface ModelOptions {
  // ネットワーク利用ポリシー ("allow" または "offline")
  network: "allow" | "offline";
  // ベースURL
  baseUrl?: string | undefined;
}

/**
 * 処理名: 埋め込み設定オプション
 * 処理概要: モデル取得・バックエンド・タイムアウト設定を定義する。
 * 実装理由: ユーザーが推論動作をカスタマイズできるようにするため。
 */
export interface EmbeddingOptions {
  // バックエンド種別
  backend?: Backend | undefined;
  // モデル取得設定
  model: ModelOptions;
  // キャッシュディレクトリ
  cacheDirectory?: string | undefined;
  // 初期化タイムアウトミリ秒
  initTimeoutMs?: number | undefined;
  // SQLタイムアウトミリ秒
  sqlTimeoutMs?: number | undefined;
}

/**
 * 処理名: 初期化実行環境情報
 * 処理概要: 実行中のプラットフォームやランタイム環境メタデータ。
 * 実装理由: 環境ポリシーの遵守と適切なバックエンド選択のため。
 */
export interface InitializationEnvironment {
  // Workerスレッド内実行か否か
  worker: boolean;
  // ランタイム種別
  runtime: "node" | "browser";
  // OSプラットフォーム
  platform: string;
  // CPUアーキテクチャ
  architecture: string;
  // Node.jsメジャーバージョン
  nodeMajor?: number | undefined;
}

/**
 * 処理名: 検証済み埋め込み設定オプション
 * 処理概要: デフォルト値が適用され検証済みの埋め込み設定。
 * 実装理由: 内部処理で確定した設定値を利用するため。
 */
export interface ReadyEmbeddingOptions extends EmbeddingOptions {
  // 確定バックエンド
  backend: Backend;
  // 確定初期化タイムアウト
  initTimeoutMs: number;
  // 確定SQLタイムアウト
  sqlTimeoutMs: number;
}

const DEFAULT_INIT_TIMEOUT_MS = 600000;
const DEFAULT_SQL_TIMEOUT_MS = 120000;
const MIN_TIMEOUT_MS = 1;
const MAX_TIMEOUT_MS = 1800000;

/**
 * 処理名: タイムアウト値検証
 * 処理概要: タイムアウト指定値が有効な範囲内の有限数値であるか検証する。
 * 実装理由: 不正なタイムアウト指定による誤動作を防止するため。
 * @param val 指定されたタイムアウトミリ秒。
 * @param defaultVal 未指定時のデフォルトミリ秒。
 * @returns 検証済みミリ秒。
 */
function validateTimeout(val: number | undefined, defaultVal: number): number {
  if (val === undefined || val === null) return defaultVal;
  if (typeof val !== "number" || !Number.isFinite(val) || val < MIN_TIMEOUT_MS || val > MAX_TIMEOUT_MS) {
    throw new VectorError("E_INPUT");
  }
  return val;
}

/**
 * 処理名: Node実行環境検証
 * 処理概要: Node.jsランタイムにおけるOS・アーキテクチャ・バージョン・バックエンド整合性を検証する。
 * 実装理由: サポート外のNode環境での推論実行を防止するため。
 * @param environment 実行環境メタデータ。
 * @param backend 選択された推論バックエンド。
 */
function validateNodeEnvironment(environment: InitializationEnvironment, backend: Backend): void {
  if (environment.platform !== "win32" && environment.platform !== "linux") {
    throw new VectorError("E_ENVIRONMENT");
  }
  if (environment.architecture !== "x64") {
    throw new VectorError("E_ENVIRONMENT");
  }
  const nodeMajor = environment.nodeMajor ?? 24;
  if (nodeMajor !== 24) {
    throw new VectorError("E_ENVIRONMENT");
  }
  if (backend === "webgpu") {
    throw new VectorError("E_ENVIRONMENT");
  }
  if (backend === "directml" && environment.platform !== "win32") {
    throw new VectorError("E_ENVIRONMENT");
  }
}

/**
 * 処理名: 実行環境整合性検証
 * 処理概要: Workerスレッドおよびランタイムごとのバックエンド互換性を検証する。
 * 実装理由: プラットフォーム非互換のバックエンド実行を防止するため。
 * @param environment 実行環境メタデータ。
 * @param backend 選択された推論バックエンド。
 */
function validateEnvironment(environment: InitializationEnvironment, backend: Backend): void {
  if (!environment.worker) {
    throw new VectorError("E_ENVIRONMENT");
  }
  if (environment.runtime === "node") {
    validateNodeEnvironment(environment, backend);
  } else if (environment.runtime === "browser") {
    if (backend === "directml") {
      throw new VectorError("E_ENVIRONMENT");
    }
  }
}

/**
 * 処理名: 埋め込みオプション検証
 * 処理概要: ユーザー提供の埋め込みオプションを検証し、確定設定オブジェクトを構築する。
 * 実装理由: 推論実行前に設定の妥当性とデフォルト値を保証するため。
 * @param options ユーザー指定の埋め込みオプション。
 * @param environment 実行環境メタデータ。
 * @returns 検証済み確定埋め込みオプション、または未指定時undefined。
 */
export function validateEmbeddingOptions(
  options: EmbeddingOptions | undefined,
  environment: InitializationEnvironment
): ReadyEmbeddingOptions | undefined {
  if (options === undefined) {
    return undefined;
  }

  if (typeof options !== "object" || options === null || typeof options.model !== "object" || options.model === null) {
    throw new VectorError("E_INPUT");
  }

  if (options.model.network !== "allow" && options.model.network !== "offline") {
    throw new VectorError("E_INPUT");
  }

  const backend = options.backend ?? "wasm";
  if (backend !== "wasm" && backend !== "webgpu" && backend !== "directml") {
    throw new VectorError("E_INPUT");
  }

  validateEnvironment(environment, backend);

  const initTimeoutMs = validateTimeout(options.initTimeoutMs, DEFAULT_INIT_TIMEOUT_MS);
  const sqlTimeoutMs = validateTimeout(options.sqlTimeoutMs, DEFAULT_SQL_TIMEOUT_MS);

  return {
    ...options,
    backend,
    initTimeoutMs,
    sqlTimeoutMs
  };
}
