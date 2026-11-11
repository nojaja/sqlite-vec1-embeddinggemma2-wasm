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
 * 処理名: 埋め込み初期化オプション
 */
export interface EmbeddingOptions {
  model?: ModelOptions;
  backend?: "wasm" | "webgpu" | "directml";
  initTimeoutMs?: number;
  sqlTimeoutMs?: number;
  models?: Record<string, unknown>;
  defaultModel?: string;
}

/**
 * 処理名: 検証済み埋め込みオプション型
 */
export interface ValidatedEmbeddingOptions {
  model: ModelOptions;
  backend: "wasm" | "webgpu" | "directml";
  initTimeoutMs: number;
  sqlTimeoutMs: number;
  models?: Record<string, unknown>;
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

  return {
    model,
    backend,
    initTimeoutMs,
    sqlTimeoutMs,
    models: options.models,
    defaultModel: options.defaultModel
  };
}
