import { VectorError } from "../errors";
import {
  BrowserInferenceController,
  type BrowserControllerHost,
  type BrowserControllerInitialization
} from "./inference-browser-controller";
import { prepareBrowserInference, configureBrowserGpu } from "../inference/browser-initialize";
import { initializeInferenceEngine, warmupImageBytes } from "../inference/initialize";
import type { PortableRuntime, InferenceEngine } from "../inference/engine";
import { createBrowserOpfsPersistentCacheStorage } from "../runtime-assets/browser-opfs-cache-storage";
import { PersistentModelCache } from "../runtime-assets/persistent-model-cache";
import { MultiModelVerifiedCache } from "../runtime-assets/verified-cache";
import { createBrowserModelReader } from "../runtime-assets/browser-model";
import { MODEL_REPOSITORY, type ModelAssetDigest, type ModelManifestProfile } from "../runtime-assets/model-contract";

/**
 * 処理名: ブラウザ推論ワーカー識別名
 * 処理概要: バンドル検証およびログ用の固定文字列。
 * 実装理由: バンドル成果物が正しいブラウザ Worker であることを検証するため。
 */
export const WORKER_NAME = "inference-browser";

const sharedMultiModelCache = new MultiModelVerifiedCache();

/**
 * 処理名: ブラウザ推論エンジン生成
 * 処理概要: OPFS 永続キャッシュ、アセット準備、ランタイム動的インポート、GPU 設定を経て推論エンジンを初期化する。
 * 実装理由: ブラウザ Worker 内で完結したゼロ構成・マルチモデル対応の推論パイプラインを確立するため。
 * @param init - 初期化パラメーター。
 * @returns 初期化済み推論エンジン。
 */
export async function createBrowserEngine(init: BrowserControllerInitialization): Promise<InferenceEngine> {
  const workerUrl = typeof location !== "undefined" ? location.href : "https://localhost/dist/workers/inference-browser.mjs";
  const opfsStorage = await createBrowserOpfsPersistentCacheStorage();
  const assets = init.manifest.assets as ModelAssetDigest[];
  const reader = createBrowserModelReader(assets, init.modelBaseUrl);
  const persistentCache = new PersistentModelCache({
    storage: opfsStorage,
    fetcher: async (asset: ModelAssetDigest): Promise<Response> => {
      const bytes = await reader(asset.path);
      if (!bytes) {
        throw new VectorError("E_MODEL_CACHE_MISS");
      }
      return new Response(bytes, { status: 200 });
    },
    assets,
    artifactSetHash: init.manifest.artifactSetHash,
    manifestHash: init.manifest.fingerprint,
    modelId: init.manifest.modelId,
    strictAllowlist: init.manifest.repository === MODEL_REPOSITORY
  });

  const prepared = await prepareBrowserInference({
    workerUrl,
    modelBaseUrl: init.modelBaseUrl,
    backend: init.backend,
    network: init.network,
    artifactSetHash: init.manifest.artifactSetHash,
    manifestHash: init.manifest.fingerprint,
    assets,
    persistentCache,
    repository: init.manifest.repository,
    revision: init.manifest.revision,
    strictAllowlist: init.manifest.repository === MODEL_REPOSITORY
  });

  sharedMultiModelCache.register(prepared.cache);

  const runtimeUrl = new URL("../vendor/transformers-portable.mjs", workerUrl).href;
  const runtime = (await import(/* @vite-ignore */ runtimeUrl)) as unknown as PortableRuntime;

  await configureBrowserGpu(runtime, init.backend);

  const manifestProfile = (init.manifest as unknown as { profile?: ModelManifestProfile }).profile;
  return initializeInferenceEngine(runtime, {
    backend: init.backend,
    cache: sharedMultiModelCache,
    wasmUrl: prepared.wasmUrl,
    factoryUrl: prepared.factoryUrl,
    codecs: prepared.codecs,
    warmupImage: warmupImageBytes(),
    modelRepository: init.manifest.repository,
    modelRevision: init.manifest.revision,
    dtype: manifestProfile?.dtype,
    dimension: manifestProfile?.dimension,
    vision: manifestProfile?.vision,
    maxTokens: manifestProfile?.maxTokens,
    prefix: manifestProfile?.prefix,
    pooling: manifestProfile?.pooling
  });
}

if (typeof self !== "undefined" && typeof (self as unknown as WorkerGlobalScope).addEventListener === "function") {
  const host: BrowserControllerHost = {
    postMessage: (msg: unknown) => (self as unknown as Worker).postMessage(msg),
    close: () => (self as unknown as WorkerGlobalScope).close()
  };
  const controller = new BrowserInferenceController(host, createBrowserEngine);
  (self as unknown as WorkerGlobalScope).addEventListener("message", (event: MessageEvent<unknown>) => {
    const data = event.data as BrowserControllerInitialization | { kind: "close" };
    controller.receiveControl(data);
  });
}
