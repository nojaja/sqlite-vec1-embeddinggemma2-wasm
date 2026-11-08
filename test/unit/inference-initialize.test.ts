import { initializeInferenceEngine } from "../../src/inference/initialize";
import type { PortableRuntime } from "../../src/inference/engine";

/**
 * 処理名: 初期化境界fixture
 * 処理概要: codec、config、processor、modelの初期化をmock化する。
 * 実装理由: warm-up完了と途中失敗の解放を実資材なしで検証するため。
 * @returns runtimeと観測用mock。
 */
function initializationFixture() {
  const model = Object.assign(jest.fn().mockResolvedValue({ sentence_embedding: { data: new Float32Array(768).fill(1), dims: [1, 768] } }), { dispose: jest.fn().mockResolvedValue(undefined) });
  const processor = Object.assign(jest.fn().mockResolvedValue({ input_ids: { data: [2n, 3n], dims: [1, 2] } }), { tokenizer: { all_special_tokens: [] } });
  const config = { audio_config: {}, vision_config: {} };
  const createModel = jest.fn().mockResolvedValue(model);
  const runtime = { env: { backends: { onnx: { wasm: {} } } }, initializeImageCodecs: jest.fn().mockResolvedValue(undefined), decodeRawImage: jest.fn().mockResolvedValue({ image: true }), AutoConfig: { from_pretrained: jest.fn().mockResolvedValue(config) }, AutoProcessor: { from_pretrained: jest.fn().mockResolvedValue(processor) }, AutoModel: { from_pretrained: createModel } } as unknown as PortableRuntime;
  const options = { backend: "wasm" as const, cache: {}, wasmUrl: "file:///ort.wasm", factoryUrl: "file:///ort.mjs", codecs: { jpeg: new Uint8Array(0), png: new Uint8Array(0), resize: new Uint8Array(0) }, warmupImage: new Uint8Array([1]) };
  return { runtime, options, config, processor, model, createModel };
}

/**
 * 処理名: READY前warm-up検証
 * 処理概要: audio無効、vision保持、text/imageの実行完了を確認する。
 * 実装理由: 初回UDF実行にmodelロードやwarm-upを残さないため。
 * @returns 検証完了。
 */
async function verifyInitialization(): Promise<void> {
  const fixture = initializationFixture();
  const engine = await initializeInferenceEngine(fixture.runtime, fixture.options);
  expect(fixture.config.audio_config).toBeNull();
  expect(fixture.config.vision_config).toEqual({});
  expect(fixture.model).toHaveBeenCalledTimes(2);
  expect(fixture.runtime.env.backends.onnx.wasm).toEqual({ numThreads: 1, proxy: false, wasmPaths: { wasm: "file:///ort.wasm", mjs: "file:///ort.mjs" } });
  expect(fixture.createModel).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ device: "wasm", dtype: { model: "q4", vision_encoder: "q4" } }));
  expect(fixture.createModel).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ session_options: { enableMemPattern: false } }));
  await engine.close();
}

/**
 * 処理名: warm-up失敗の解放検証
 * 処理概要: 初期化途中の推論失敗でもmodelをdisposeする。
 * 実装理由: open失敗後にsessionとGPU資源を残さないため。
 * @returns 検証完了。
 */
async function verifyWarmupFailure(): Promise<void> {
  const fixture = initializationFixture();
  fixture.model.mockRejectedValueOnce(new Error("private failure"));
  await expect(initializeInferenceEngine(fixture.runtime, fixture.options)).rejects.toThrow("E_INFERENCE");
  expect(fixture.model.dispose).toHaveBeenCalledTimes(1);
}

/**
 * 処理名: DirectML初期化境界検証
 * 処理概要: Wasm設定を持たないruntimeへDML固有session条件だけを渡す。
 * 実装理由: DirectMLからWasmへの暗黙fallbackとportable runtime依存を防ぐため。
 * @returns 検証完了。
 */
async function verifyDirectMlInitialization(): Promise<void> {
  const fixture = initializationFixture();
  fixture.runtime.env = { backends: { onnx: {} } } as PortableRuntime["env"];
  const directMlOptions = {
    backend: "directml" as const,
    graphOptimizationLevel: "disabled" as const,
    cache: fixture.options.cache,
    codecs: fixture.options.codecs,
    warmupImage: fixture.options.warmupImage
  };
  const engine = await initializeInferenceEngine(fixture.runtime, directMlOptions);
  expect(fixture.createModel).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
    device: "dml",
    session_options: { enableMemPattern: false, executionMode: "sequential", freeDimensionOverrides: { s11: 1, s35: 2520 }, graphOptimizationLevel: "disabled", logSeverityLevel: 4 }
  }));
  await engine.close();
}

test("G02/R10: warm up before READY without audio", verifyInitialization);
test("R10: initialization failure releases session", verifyWarmupFailure);
test("G02-DML: DirectML initialization does not require Wasm settings", verifyDirectMlInitialization);