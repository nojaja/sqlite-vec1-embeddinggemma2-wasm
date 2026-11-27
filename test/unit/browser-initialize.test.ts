import { createHash } from "node:crypto";
import { configureBrowserGpu, prepareBrowserInference, type BrowserPersistentModelCache } from "../../src/inference/browser-initialize";
import type { PortableRuntime } from "../../src/inference/engine";
import { MODEL_ASSET_FILES, type ModelAssetDigest } from "../../src/runtime-assets/model-contract";

const modelBytes = new Uint8Array([1, 2, 3, 4]);

/**
 * 処理名: browser manifest fixture
 * 処理概要: 全11資材へ同じ検証用digestを割り当てる。
 * 実装理由: 実モデルなしで完全manifest cacheを構築するため。
 * @returns browser初期化用の完全資材集合。
 */
function browserManifestAssets(): ModelAssetDigest[] {
  const sha256 = createHash("sha256").update(modelBytes).digest("hex");
  return MODEL_ASSET_FILES.map((asset) => ({ path: asset.path, bytes: modelBytes.byteLength, sha256 }));
}

/**
 * 処理名: browser初期化fixture
 * 処理概要: package資材とmodel資材を返すfetch mockを作る。
 * 実装理由: networkなしでURL解決とcache接続を観測するため。
 * @returns fetch mock。
 */
function browserFetchFixture(): jest.Mock<Promise<Response>, [string, RequestInit]> {
  return jest.fn(async (url: string, _init: RequestInit) => new Response(url.includes("/models/") ? modelBytes : new Uint8Array([9, 8, 7]), { status: 200 }));
}

/**
 * 処理名: browser永続cache fixture
 * 処理概要: initialize modeを記録しmodel bytesを返す。
 * 実装理由: OPFS実体なしで初期化順序とoffline modeを検証するため。
 * @returns fake cacheとmode記録。
 */
function persistentCacheFixture(): { cache: BrowserPersistentModelCache; modes: string[] } {
  const modes: string[] = [];
  let ready = false;
  /**
 * 処理名: fake cache初期化。処理概要: modeを記録してreadyにする。実装理由: 消費前初期化を観測するため。
 * @param mode - cache mode。
 */
  async function initialize(mode: "online" | "offline"): Promise<void> { modes.push(mode); ready = true; }
  /**
 * 処理名: fake cache読込み。処理概要: ready後だけmodel bytesを返す。実装理由: 初期化順序を強制するため。
 * @param _path - manifest path。
 * @returns model bytes。
 */
  async function read(_path: string): Promise<Uint8Array> { if (!ready) throw new Error("not ready"); return modelBytes; }
  return { cache: { initialize, read }, modes };
}

/**
 * 処理名: browser初期化条件検証
 * 処理概要: ORT URL、codec bytes、検証済みmodel cacheを確認する。
 * 実装理由: browser WorkerがNode path APIなしで同一package資材を解決するため。
 * @returns 検証完了。
 */
async function verifyBrowserInitialization(): Promise<void> {
  const fetcher = browserFetchFixture();
  const persistent = persistentCacheFixture();
  const prepared = await prepareBrowserInference({
    workerUrl: "https://example.test/dist/workers/inference-browser.mjs",
    modelBaseUrl: "https://example.test/models/fixed/",
    backend: "wasm",
    network: "allow",
    artifactSetHash: "a".repeat(64),
    manifestHash: "b".repeat(64),
    assets: browserManifestAssets(),
    fetcher,
    persistentCache: persistent.cache
  });
  expect(persistent.modes).toEqual(["online"]);
  expect(prepared.wasmUrl).toBe("https://example.test/dist/ort/ort-wasm-simd-threaded.jsep.wasm");
  expect(prepared.factoryUrl).toBe("https://example.test/dist/ort/ort-wasm-simd-threaded.jsep.mjs");
  expect(prepared.codecs.jpeg).toEqual(new Uint8Array([9, 8, 7]));
  expect(prepared.codecs.png).toEqual(new Uint8Array([9, 8, 7]));
  expect(prepared.codecs.resize).toEqual(new Uint8Array([9, 8, 7]));
  const cached = await prepared.cache.match("/models/onnx-community/embeddinggemma-2-ONNX/config.json");
  expect(new Uint8Array(await (cached as Response).arrayBuffer())).toEqual(modelBytes);
  const offlinePersistent = persistentCacheFixture();
  const webgpu = await prepareBrowserInference({
    workerUrl: "https://example.test/dist/workers/inference-browser.mjs",
    modelBaseUrl: "https://example.test/models/fixed/",
    backend: "webgpu",
    network: "offline",
    artifactSetHash: "a".repeat(64),
    manifestHash: "b".repeat(64),
    assets: browserManifestAssets(),
    fetcher,
    persistentCache: offlinePersistent.cache
  });
  expect(offlinePersistent.modes).toEqual(["offline"]);
  expect(webgpu.wasmUrl).toBe("https://example.test/dist/ort/ort-wasm-simd-threaded.jspi.wasm");
  expect(webgpu.factoryUrl).toBe("https://example.test/dist/ort/ort-wasm-simd-threaded.jspi.mjs");
}

/**
 * 処理名: browser初期化境界検証
 * 処理概要: 外部HTTPS CDNのmodelBaseUrlを許可し、安全でないURLやpackage資材HTTP失敗を拒否する。
 * 実装理由: オンデマンドCDN取得を許可しつつ、不正URLや部分資材での初期化継続を防ぐため。
 * @returns 検証完了。
 */
async function verifyBrowserInitializationFailure(): Promise<void> {
  await expect(prepareBrowserInference({
    workerUrl: "https://example.test/dist/workers/inference-browser.mjs",
    modelBaseUrl: "https://other.test/models/fixed/",
    backend: "wasm",
    network: "allow",
    artifactSetHash: "a".repeat(64),
    manifestHash: "b".repeat(64),
    assets: browserManifestAssets(),
    fetcher: browserFetchFixture(),
    persistentCache: persistentCacheFixture().cache
  })).resolves.toMatchObject({
    wasmUrl: "https://example.test/dist/ort/ort-wasm-simd-threaded.jsep.wasm"
  });
  await expect(prepareBrowserInference({
    workerUrl: "http://example.test/dist/workers/inference-browser.mjs",
    modelBaseUrl: "http://example.test/models/fixed/",
    backend: "wasm",
    network: "allow",
    artifactSetHash: "a".repeat(64),
    manifestHash: "b".repeat(64),
    assets: browserManifestAssets(),
    fetcher: browserFetchFixture(),
    persistentCache: persistentCacheFixture().cache
  })).rejects.toThrow("E_ASSET_INTEGRITY");
  const failedFetch = jest.fn<Promise<Response>, [string, RequestInit]>().mockResolvedValue(new Response(null, { status: 404 }));
  await expect(prepareBrowserInference({
    workerUrl: "https://example.test/dist/workers/inference-browser.mjs",
    modelBaseUrl: "https://example.test/models/fixed/",
    backend: "wasm",
    network: "allow",
    artifactSetHash: "a".repeat(64),
    manifestHash: "b".repeat(64),
    assets: browserManifestAssets(),
    fetcher: failedFetch,
    persistentCache: persistentCacheFixture().cache
  })).rejects.toThrow("E_ASSET_INTEGRITY");
}

/**
 * 処理名: browser GPU adapter明示設定
 * 処理概要: WebGPUだけが既定adapterを取得してORT envへ設定することを確認する。
 * 実装理由: 上流のhigh-performance自動選択で利用可能adapterを見失わないため。
 * @returns 検証完了。
 */
async function verifyBrowserGpuConfiguration(): Promise<void> {
  const runtime = { env: { backends: { onnx: { wasm: {}, webgpu: {} } } } } as unknown as PortableRuntime;
  const adapter = { fixed: true };
  const requestAdapter = jest.fn().mockResolvedValue(adapter);
  await configureBrowserGpu(runtime, "wasm", { requestAdapter });
  expect(requestAdapter).not.toHaveBeenCalled();
  await configureBrowserGpu(runtime, "webgpu", { requestAdapter });
  expect(requestAdapter).toHaveBeenCalledWith();
  expect((runtime.env.backends.onnx as unknown as { webgpu: { adapter?: unknown } }).webgpu.adapter).toBe(adapter);
  await expect(configureBrowserGpu(runtime, "webgpu", { requestAdapter: jest.fn().mockResolvedValue(null) })).rejects.toThrow("E_ENVIRONMENT");
}

/**
 * 処理名: カスタムモデル用少数アセット fixture
 * 処理概要: 11資材ではない任意モデル（例: 5資材）のダイジェスト配列を生成する。
 * 実装理由: strictAllowlist=false 時の任意アセット数モデル受容を検証するため。
 * @returns 5資材のモデルアセット一覧。
 */
function customModelAssets(): ModelAssetDigest[] {
  const sha256 = createHash("sha256").update(modelBytes).digest("hex");
  const paths = [
    "onnx/model_q4.onnx",
    "config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "config_sentence_transformers.json"
  ];
  return paths.map((path) => ({ path, bytes: modelBytes.byteLength, sha256 }));
}

/**
 * 処理名: カスタムモデルbrowser初期化検証
 * 処理概要: アセット数11以外のモデルで repository/revision/strictAllowlist を渡した際に E_ASSET_INTEGRITY にならずキャッシュ解決できることを確認する。
 * 実装理由: マルチモデル登録時に EmbeddingGemma 2 以外のモデルが拒絶される不具合を防ぐため。
 * @returns 検証完了。
 */
async function verifyCustomModelBrowserInitialization(): Promise<void> {
  const repository = "cl-nagoya/ruri-v3-310m-ONNX";
  const revision = "v1.0.0";
  const assets = customModelAssets();
  const prepared = await prepareBrowserInference({
    workerUrl: "https://example.test/dist/workers/inference-browser.mjs",
    modelBaseUrl: "https://example.test/models/ruri-v3/",
    backend: "wasm",
    network: "allow",
    artifactSetHash: "c".repeat(64),
    manifestHash: "d".repeat(64),
    assets,
    fetcher: browserFetchFixture(),
    persistentCache: persistentCacheFixture().cache,
    repository,
    revision,
    strictAllowlist: false
  });
  const localCached = await prepared.cache.match(`/models/${repository}/config.json`);
  expect(new Uint8Array(await (localCached as Response).arrayBuffer())).toEqual(modelBytes);
  const remoteCached = await prepared.cache.match(`https://huggingface.co/${repository}/resolve/${revision}/config.json`);
  expect(new Uint8Array(await (remoteCached as Response).arrayBuffer())).toEqual(modelBytes);

  await expect(prepareBrowserInference({
    workerUrl: "https://example.test/dist/workers/inference-browser.mjs",
    modelBaseUrl: "https://example.test/models/ruri-v3/",
    backend: "wasm",
    network: "allow",
    artifactSetHash: "c".repeat(64),
    manifestHash: "d".repeat(64),
    assets,
    fetcher: browserFetchFixture(),
    persistentCache: persistentCacheFixture().cache,
    repository,
    revision,
    strictAllowlist: true
  })).rejects.toThrow("E_ASSET_INTEGRITY");
}

test("G02: browser prepares same-origin inference assets", verifyBrowserInitialization);
test("G02: browser rejects unsafe or missing inference assets", verifyBrowserInitializationFailure);
test("G02: browser injects an explicit WebGPU adapter without fallback", verifyBrowserGpuConfiguration);
test("G02: browser prepares custom model with non-11 assets when strictAllowlist is false", verifyCustomModelBrowserInitialization);