import { VectorError } from "../errors";

export type Backend = "wasm" | "webgpu" | "directml";

export interface EmbeddingOptions {
  backend?: Backend;
  model: { network: "allow" | "offline"; baseUrl?: string };
  cacheDirectory?: string;
  initTimeoutMs?: number;
  sqlTimeoutMs?: number;
}

export interface InitializationEnvironment {
  worker: boolean;
  runtime: "node" | "browser";
  platform: string;
  architecture: string;
  nodeMajor?: number;
}

export interface ReadyEmbeddingOptions extends EmbeddingOptions {
  backend: Backend;
  initTimeoutMs: number;
  sqlTimeoutMs: number;
}

const DEFAULT_INIT_TIMEOUT_MS = 600000;
const DEFAULT_SQL_TIMEOUT_MS = 120000;
const MIN_TIMEOUT_MS = 1;
const MAX_TIMEOUT_MS = 1800000;

export function validateEmbeddingOptions(
  options: EmbeddingOptions | undefined,
  environment: InitializationEnvironment
): ReadyEmbeddingOptions | undefined {
  if (options === undefined) {
    return undefined;
  }

  if (!environment.worker) {
    throw new VectorError("E_ENVIRONMENT");
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

  if (environment.runtime === "node") {
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
  } else if (environment.runtime === "browser") {
    if (backend === "directml") {
      throw new VectorError("E_ENVIRONMENT");
    }
  }

  const validateTimeout = (val: number | undefined, defaultVal: number): number => {
    if (val === undefined || val === null) return defaultVal;
    if (typeof val !== "number" || !Number.isFinite(val) || val < MIN_TIMEOUT_MS || val > MAX_TIMEOUT_MS) {
      throw new VectorError("E_INPUT");
    }
    return val;
  };

  const initTimeoutMs = validateTimeout(options.initTimeoutMs, DEFAULT_INIT_TIMEOUT_MS);
  const sqlTimeoutMs = validateTimeout(options.sqlTimeoutMs, DEFAULT_SQL_TIMEOUT_MS);

  return {
    ...options,
    backend,
    initTimeoutMs,
    sqlTimeoutMs
  };
}
