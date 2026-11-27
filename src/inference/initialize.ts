import { VectorError } from "../errors";
import { MODEL_REPOSITORY, MODEL_REVISION } from "../runtime-assets/model-contract";
import {
  InferenceEngine,
  PortableRuntime,
  RuntimeModel,
  RuntimeProcessor
} from "./engine";
import { ImageCodecBytes } from "./image-codecs";
import { EMBEDDING_DIMENSION, TextPrefixConfig } from "./profile";

/**
 * 処理名: 1px PNG ウォームアップ画像バイナリ生成
 * 処理概要: ウォームアップ用の最小透明 1px PNG バイト配列を返す。
 * 実装理由: 画像推論パイプラインを事前実行し、初期待ち時間を排除するため。
 * @returns 1px PNG バイナリ。
 */
export function warmupImageBytes(): Uint8Array {
  const base64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
  if (typeof Buffer !== "undefined") {
    return Uint8Array.from(Buffer.from(base64, "base64"));
  }
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

/**
 * 処理名: 推論初期化オプション
 * 処理概要: バックエンド、キャッシュ、Wasm URL、コーデック、ウォームアップ画像、最適化レベルを定義する。
 */
export interface InferenceInitializationOptions {
  backend: "wasm" | "webgpu" | "directml";
  cache: object;
  wasmUrl?: string;
  factoryUrl?: string;
  codecs?: ImageCodecBytes;
  warmupImage?: Uint8Array;
  graphOptimizationLevel?: "disabled" | "basic" | "extended" | "all";
  modelRepository?: string | undefined;
  modelRevision?: string | undefined;
  dtype?: string | Record<string, string> | undefined;
  dimension?: number | undefined;
  vision?: boolean | undefined;
  maxTokens?: number | undefined;
  prefix?: TextPrefixConfig | undefined;
}

/**
 * 処理名: 推論エンジン初期化
 * 処理概要: ランタイム環境設定、コーデック初期化、モデル・プロセッサロード、2回のウォームアップを実行する。
 * 実装理由: audio を無効化しつつ vision を保持し、READY 前に完全に推論準備を整えるため。
 * @param runtime - ポータブルランタイム。
 * @param options - 初期化オプション。
 * @returns 初期化およびウォームアップ完了済み InferenceEngine。
 */
export async function initializeInferenceEngine(
  runtime: PortableRuntime,
  options: InferenceInitializationOptions
): Promise<InferenceEngine> {
  const env = runtime.env as Record<string, unknown>;
  env.useCustomCache = true;
  env.customCache = options.cache;
  env.useBrowserCache = false;
  env.useFSCache = false;
  env.useFS = false;
  env.allowLocalModels = true;
  env.allowRemoteModels = false;
  env.localModelPath = "/models/";
  env.useWasmCache = false;

  if (options.wasmUrl && options.factoryUrl) {
    const onnx = ((env.backends as Record<string, unknown>)?.onnx as Record<string, unknown>) ?? {};
    onnx.wasm = {
      numThreads: 1,
      proxy: false,
      wasmPaths: {
        wasm: options.wasmUrl,
        mjs: options.factoryUrl
      }
    };
  }

  const modelRepository = options.modelRepository ?? MODEL_REPOSITORY;
  const modelRevision = options.modelRevision ?? MODEL_REVISION;
  const visionEnabled = options.vision ?? true;
  const dimension = options.dimension ?? EMBEDDING_DIMENSION;

  if (visionEnabled && typeof runtime.initializeImageCodecs === "function" && options.codecs) {
    await runtime.initializeImageCodecs(options.codecs);
  }

  const config = (await runtime.AutoConfig.from_pretrained(modelRepository, {
    revision: modelRevision,
    local_files_only: true
  })) as { audio_config?: unknown; vision_config?: unknown };

  if (config && typeof config === "object" && "audio_config" in config) {
    config.audio_config = null; // audio 無効化、vision_config は保持
  }

  const processor = (await runtime.AutoProcessor.from_pretrained(modelRepository, {
    config,
    revision: modelRevision,
    local_files_only: true
  })) as RuntimeProcessor;

  const sessionOptions: Record<string, unknown> = {
    enableMemPattern: false
  };

  if (options.backend === "directml") {
    sessionOptions.executionMode = "sequential";
    sessionOptions.freeDimensionOverrides = { s11: 1, s35: 2520 };
    sessionOptions.graphOptimizationLevel = options.graphOptimizationLevel ?? "all";
    sessionOptions.logSeverityLevel = 4;
  }

  const defaultDtype = visionEnabled ? { model: "q4", vision_encoder: "q4" } : "q4";
  const modelOptions = {
    device: options.backend === "directml" ? "dml" : options.backend,
    dtype: options.dtype ?? defaultDtype,
    config,
    revision: modelRevision,
    local_files_only: true,
    session_options: sessionOptions
  };

  const model = (await runtime.AutoModel.from_pretrained(
    modelRepository,
    modelOptions
  )) as RuntimeModel;

  const engine = new InferenceEngine(runtime, {
    dimension,
    maxTokens: options.maxTokens,
    vision: visionEnabled,
    prefix: options.prefix
  });
  engine.attach(processor, model);

  try {
    // 1. クエリウォームアップ
    await engine.embed({ operation: "query", body: "warm up" });
    // 2. 画像ウォームアップ (vision 対応モデルのみ)
    if (visionEnabled) {
      const imgBytes = options.warmupImage ?? warmupImageBytes();
      await engine.embed({ operation: "image", bytes: imgBytes, mime: "image/png" });
    }
  } catch (err: unknown) {
    await engine.close();
    if (err instanceof VectorError) {
      throw err;
    }
    throw new VectorError("E_INFERENCE");
  }

  return engine;
}
