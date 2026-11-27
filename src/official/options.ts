import { VectorError } from "../errors";

/**
 * 処理名: 実行環境情報インターフェース
 */
export interface EnvironmentInfo {
  worker: boolean;
  runtime: "node" | "browser";
  platform: string;
  architecture: string;
  nodeMajor?: number;
}

/**
 * 処理名: モデルネットワークポリシーオプション
 */
export interface ModelOptions {
  network: "allow" | "offline";
  baseUrl?: string;
  cacheDirectory?: string;
}

/**
 * 処理名: モデルアセット簡易設定型
 * 処理概要: ユーザーがモデル構成時に指定する資材パスおよび任意完全性情報を表す。
 * 実装理由: ruri-v3 等のカスタムモデルをインラインで指定可能にするため。
 */
export interface ModelAssetConfig {
  path: string;
  bytes?: number;
  sha256?: string;
  role?: string;
}

/**
 * 処理名: 個別モデル設定オプション型
 * 処理概要: マニフェスト URL、インラインマニフェスト、リポジトリ・ONNX 設定、次元数等を定義する。
 * 実装理由: 複数モデル登録時にモデルごとの取得元や推論プロファイルを柔軟に指定するため。
 */
export interface ModelConfigOptions {
  manifestUrl?: string;
  manifest?: Record<string, unknown>;
  repository?: string;
  revision?: string;
  baseUrl?: string;
  network?: "allow" | "offline";
  cacheDirectory?: string;
  dimension?: number;
  dtype?: string;
  vision?: boolean;
  maxTokens?: number;
  assets?: (string | ModelAssetConfig)[];
  prefix?: { query?: string; document?: string };
  normalize?: boolean;
  preload?: boolean;
}

/**
 * 処理名: 埋め込み初期化オプション
 */
export interface EmbeddingOptions {
  model?: ModelOptions;
  backend?: "wasm" | "webgpu" | "directml";
  workerUrl?: string;
  manifestUrl?: string;
  initTimeoutMs?: number;
  sqlTimeoutMs?: number;
  models?: Record<string, ModelConfigOptions | string>;
  defaultModel?: string;
}

/**
 * 処理名: 検証済み埋め込みオプション型
 */
export interface ValidatedEmbeddingOptions {
  model: ModelOptions;
  backend: "wasm" | "webgpu" | "directml";
  workerUrl?: string;
  manifestUrl?: string;
  initTimeoutMs: number;
  sqlTimeoutMs: number;
  models?: Record<string, ModelConfigOptions | string>;
  defaultModel?: string;
}

/**
 * 処理名: 埋め込みオプション検証
 * 処理概要: 実行環境マトリクス、バックエンド適合性、タイムアウト境界、モデルネットワークポリシーを検証する。
 * 実装理由: 不正な設定やサポート外プラットフォームでの無言の動作不良・CPUフォールバックを防止するため。
 * @param options - ユーザー指定の埋め込みオプション。
 * @param env - 実行環境情報。
 * @returns 検証済み埋め込みオプション、または options が undefined の場合 undefined。
 */
export function validateEmbeddingOptions(
  options: EmbeddingOptions | undefined,
  env: EnvironmentInfo
): ValidatedEmbeddingOptions | undefined {
  if (options === undefined) {
    return undefined;
  }

  // Node.js 実行環境マトリクス検証
  if (env.runtime === "node") {
    if (env.platform !== "win32" && env.platform !== "linux") {
      throw new VectorError("E_ENVIRONMENT");
    }
    if (env.architecture !== "x64") {
      throw new VectorError("E_ENVIRONMENT");
    }
    if (env.nodeMajor !== undefined) {
      if (env.nodeMajor % 2 !== 0 || env.nodeMajor < 20 || env.nodeMajor > 24) {
        throw new VectorError("E_ENVIRONMENT");
      }
    }
  }

  // モデルオプション検証
  const model = options.model ?? { network: "offline" };
  if (model.network !== "allow" && model.network !== "offline") {
    throw new VectorError("E_INPUT");
  }

  // バックエンド検証
  const rawBackend = (options as { backend?: string }).backend;
  if (rawBackend !== undefined && rawBackend !== "wasm" && rawBackend !== "webgpu" && rawBackend !== "directml") {
    throw new VectorError("E_INPUT");
  }

  const backend = options.backend ?? "wasm";

  if (env.runtime === "node") {
    if (backend === "webgpu") {
      throw new VectorError("E_ENVIRONMENT");
    }
    if (backend === "directml") {
      if (env.platform !== "win32" || env.architecture !== "x64") {
        throw new VectorError("E_ENVIRONMENT");
      }
    }
  } else if (env.runtime === "browser") {
    if (!env.worker) {
      console.warn(
        "SQLite synchronous embedding UDFs require Atomics.wait and cannot run on the browser main thread. Run initialize({ embedding }) inside a Dedicated Worker or use sqlite3EmbeddingWorkerPromiser()."
      );
      throw new VectorError("E_ENVIRONMENT");
    }
    if (backend === "directml") {
      throw new VectorError("E_ENVIRONMENT");
    }
  }

  // タイムアウト検証 (1ms 〜 1800000ms = 30分)
  function validateTimeout(val: unknown, defaultVal: number): number {
    if (val === undefined) return defaultVal;
    if (typeof val !== "number" || !Number.isFinite(val) || Number.isNaN(val) || val < 1 || val > 1800000) {
      throw new VectorError("E_INPUT");
    }
    return val;
  }

  const initTimeoutMs = validateTimeout(options.initTimeoutMs, 600000);
  const sqlTimeoutMs = validateTimeout(options.sqlTimeoutMs, 120000);

  if (options.workerUrl !== undefined && (typeof options.workerUrl !== "string" || options.workerUrl.trim().length === 0)) {
    throw new VectorError("E_INPUT");
  }
  if (options.manifestUrl !== undefined && (typeof options.manifestUrl !== "string" || options.manifestUrl.trim().length === 0)) {
    throw new VectorError("E_INPUT");
  }
  validateMultiModelOptions(options.models, options.defaultModel);

  return {
    model,
    backend,
    workerUrl: options.workerUrl,
    manifestUrl: options.manifestUrl,
    initTimeoutMs,
    sqlTimeoutMs,
    models: options.models,
    defaultModel: options.defaultModel
  };
}

/**
 * 処理名: マルチモデル設定整合性検証
 * 処理概要: models マップと defaultModel の型および登録整合性を検証する。
 * 実装理由: 未登録モデルを defaultModel に指定する設定ミスを初期化時に E_INPUT で早期検知するため。
 * @param models - モデル設定マップ。
 * @param defaultModel - 既定モデル名。
 */
function validateMultiModelOptions(
  models: Record<string, ModelConfigOptions | string> | undefined,
  defaultModel: string | undefined
): void {
  if (defaultModel !== undefined && (typeof defaultModel !== "string" || defaultModel.trim().length === 0)) {
    throw new VectorError("E_INPUT");
  }
  if (models === undefined) {
    return;
  }
  if (typeof models !== "object" || models === null || Array.isArray(models)) {
    throw new VectorError("E_INPUT");
  }
  const keys = Object.keys(models);
  if (keys.length === 0) {
    throw new VectorError("E_INPUT");
  }
  for (const key of keys) {
    if (key.trim().length === 0) {
      throw new VectorError("E_INPUT");
    }
    const entry = models[key];
    if (typeof entry === "string") {
      if (entry.trim().length === 0) throw new VectorError("E_INPUT");
    } else if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new VectorError("E_INPUT");
    }
  }
  if (defaultModel !== undefined && !Object.prototype.hasOwnProperty.call(models, defaultModel)) {
    throw new VectorError("E_INPUT");
  }
}
