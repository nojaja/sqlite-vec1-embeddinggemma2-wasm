import { VectorError } from "../errors";
import { MODEL_REPOSITORY, MODEL_REVISION } from "../runtime-assets/model-contract";
import type { ImageCodecBytes } from "./image-codecs";
import { InferenceEngine, type PortableRuntime } from "./engine";

/** 共通初期化入力。 */
interface CommonInitialization { cache: object; codecs: ImageCodecBytes; warmupImage: Uint8Array }
/** wasm/webgpu用初期化入力。 */
export interface OrtWebInitialization extends CommonInitialization { backend: "wasm" | "webgpu"; wasmUrl: string; factoryUrl: string }
/** DirectML用初期化入力。 */
export interface DirectMlInitialization extends CommonInitialization { backend: "directml"; graphOptimizationLevel?: "disabled" | "basic" | "extended" | "all" }
/** 推論初期化入力。 */
export type InferenceInitialization = OrtWebInitialization | DirectMlInitialization;

/** 共通warm-up用1px PNG(base64)。 */
const WARMUP_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";

/**
 * 処理名: warm-up画像取得
 * 処理概要: Node/browser共通の1px PNG bytesを返す。
 * 実装理由: 両環境で同じwarm-up入力を使うため。
 * @returns 独立所有のPNG bytes。
 */
export function warmupImageBytes(): Uint8Array {
  return Uint8Array.from(atob(WARMUP_PNG_BASE64), (character) => character.charCodeAt(0));
}

/**
 * 処理名: runtime環境設定
 * 処理概要: 検証済みcacheと固定loader設定をruntime envへ設定する。
 * 実装理由: cache外通信・FS利用・browser cacheを無効にするため。
 * @param runtime - 外部runtime。
 * @param options - 初期化入力。
 */
function configureRuntime(runtime: PortableRuntime, options: InferenceInitialization): void {
  Object.assign(runtime.env, {
    useCustomCache: true, customCache: options.cache, useBrowserCache: false, useFSCache: false, useFS: false,
    allowLocalModels: true, allowRemoteModels: false, localModelPath: "/models/", useWasmCache: false,
    fetch: async () => { throw new VectorError("E_ASSET_INTEGRITY"); }
  });
  if (options.backend !== "directml") {
    if (!runtime.env.backends.onnx.wasm) {
      runtime.env.backends.onnx.wasm = {};
    }
    Object.assign(runtime.env.backends.onnx.wasm, {
      numThreads: 1,
      proxy: false,
      wasmPaths: { wasm: options.wasmUrl, mjs: options.factoryUrl }
    });
    // 確実に numThreads: 1 を維持
    runtime.env.backends.onnx.wasm.numThreads = 1;
    runtime.env.backends.onnx.wasm.proxy = false;
  }
}

/**
 * 処理名: model option作成
 * 処理概要: backend別のdevice/session optionを作る。
 * 実装理由: DirectMLからWasmへの暗黙fallbackを作らないため。
 * @param options - 初期化入力。
 * @returns model読込みoption。
 */
function sessionOptions(options: InferenceInitialization): { device: string; session_options: Record<string, unknown> } {
  if (options.backend === "directml") {
    return {
      device: "dml",
      session_options: {
        enableMemPattern: false, executionMode: "sequential", freeDimensionOverrides: { s11: 1, s35: 2520 },
        graphOptimizationLevel: options.graphOptimizationLevel ?? "all", logSeverityLevel: 4
      }
    };
  }
  return { device: options.backend, session_options: { enableMemPattern: false } };
}

/**
 * 処理名: 推論engine初期化
 * 処理概要: codec、config、processor、q4 model、warm-upの順に初期化する。
 * 実装理由: READY前に全資材を使える状態にし、失敗時は資源を解放するため。
 * @param runtime - 外部runtime。
 * @param options - 初期化入力。
 * @returns warm-up済みengine。
 */
export async function initializeInferenceEngine(runtime: PortableRuntime, options: InferenceInitialization): Promise<InferenceEngine> {
  configureRuntime(runtime, options);
  await runtime.initializeImageCodecs(options.codecs);
  const common = { local_files_only: true, revision: MODEL_REVISION };
  const config = await runtime.AutoConfig.from_pretrained(MODEL_REPOSITORY, common);
  config.audio_config = null;
  const processor = await runtime.AutoProcessor.from_pretrained(MODEL_REPOSITORY, common);
  const model = await runtime.AutoModel.from_pretrained(MODEL_REPOSITORY, { ...common, config, dtype: { model: "q4", vision_encoder: "q4" }, ...sessionOptions(options) });
  const engine = new InferenceEngine(runtime);
  engine.attach(processor, model);
  try {
    await engine.embed({ operation: "query", body: "warm up" });
    await engine.embed({ operation: "image", bytes: options.warmupImage, mime: "image/png" });
    return engine;
  } catch (error) {
    await engine.close();
    throw error;
  }
}
