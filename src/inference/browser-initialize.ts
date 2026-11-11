import { VectorError } from "../errors";
import { ModelAssetDigest } from "../runtime-assets/model-contract";
import { VerifiedModelCache } from "../runtime-assets/verified-cache";
import { isSecureBrowserUrl } from "../runtime-assets/browser-model";
import { ImageCodecBytes } from "./image-codecs";
import { PortableRuntime } from "./engine";

/**
 * 処理名: ブラウザ永続モデルキャッシュインターフェース
 * 処理概要: 初期化および資材読み出しを提供する。
 */
export interface BrowserPersistentModelCache {
  initialize(mode: "online" | "offline"): Promise<void>;
  read(path: string): Promise<Uint8Array | undefined>;
}

/**
 * 処理名: ブラウザ推論準備完了構造体
 * 処理概要: 検証済みキャッシュ、ORT Wasm URL、ファクトリ URL、コーデックバイナリを保持する。
 */
export interface PreparedBrowserInference {
  cache: VerifiedModelCache;
  wasmUrl: string;
  factoryUrl: string;
  codecs: ImageCodecBytes;
}

/**
 * 処理名: ブラウザ推論初期化準備オプション
 * 処理概要: ワーカー URL、モデルベース URL、バックエンド、ネットワーク設定、資材一覧を定義する。
 */
export interface PrepareBrowserInferenceOptions {
  workerUrl: string;
  modelBaseUrl: string;
  backend: "wasm" | "webgpu" | "directml";
  network: "allow" | "offline";
  artifactSetHash: string;
  manifestHash: string;
  assets: readonly ModelAssetDigest[];
  fetcher?: typeof fetch;
  persistentCache?: BrowserPersistentModelCache;
}

/**
 * 処理名: ブラウザ推論準備
 * 処理概要: 同一オリジン検証、永続キャッシュ初期化、ORT Wasm/ファクトリ URL 解決、コーデックバイナリ取得を行う。
 * 実装理由: ブラウザ Worker 起動時に必要な全資材を同一オリジン安全規約のもとで準備するため。
 * @param options - ブラウザ推論準備オプション。
 * @returns 準備完了した PreparedBrowserInference。
 */
export async function prepareBrowserInference(
  options: PrepareBrowserInferenceOptions
): Promise<PreparedBrowserInference> {
  let workerParsed: URL;
  let modelBaseParsed: URL;

  try {
    workerParsed = new URL(options.workerUrl);
    modelBaseParsed = new URL(options.modelBaseUrl);
  } catch {
    throw new VectorError("E_ASSET_INTEGRITY");
  }

  if (!isSecureBrowserUrl(workerParsed) || !isSecureBrowserUrl(modelBaseParsed)) {
    throw new VectorError("E_ASSET_INTEGRITY");
  }

  if (workerParsed.origin !== modelBaseParsed.origin) {
    throw new VectorError("E_ASSET_INTEGRITY");
  }

  // workerUrl (例: https://example.test/dist/workers/inference-browser.mjs) から package base (https://example.test/) を導出
  const packageBaseUrl = new URL("../..", workerParsed);
  if (!packageBaseUrl.href.endsWith("/")) {
    packageBaseUrl.href += "/";
  }

  let wasmFileName: string;
  let factoryFileName: string;

  if (options.backend === "webgpu") {
    wasmFileName = "dist/ort/ort-wasm-simd-threaded.jspi.wasm";
    factoryFileName = "dist/ort/ort-wasm-simd-threaded.jspi.mjs";
  } else {
    wasmFileName = "dist/ort/ort-wasm-simd-threaded.jsep.wasm";
    factoryFileName = "dist/ort/ort-wasm-simd-threaded.jsep.mjs";
  }

  const wasmUrl = new URL(wasmFileName, packageBaseUrl).href;
  const factoryUrl = new URL(factoryFileName, packageBaseUrl).href;

  const fetcher = options.fetcher ?? fetch;

  /**
   * 処理名: パッケージ資材フェッチ
   * 処理概要: 相対パスから資材を fetch して Uint8Array で返す。
   * @param relPath - パッケージ内相対パス。
   * @returns 取得されたバイナリ。
   */
  async function fetchPackageAsset(relPath: string): Promise<Uint8Array> {
    const assetUrl = new URL(relPath, packageBaseUrl).href;
    const res = await fetcher(assetUrl, { cache: "no-store", credentials: "omit" });
    if (!res.ok) {
      throw new VectorError("E_ASSET_INTEGRITY");
    }
    const ab = await res.arrayBuffer();
    return new Uint8Array(ab);
  }

  let jpeg: Uint8Array;
  let png: Uint8Array;
  let resize: Uint8Array;

  try {
    [jpeg, png, resize] = await Promise.all([
      fetchPackageAsset("dist/image/jpeg.wasm"),
      fetchPackageAsset("dist/image/png.wasm"),
      fetchPackageAsset("dist/image/resize.wasm")
    ]);
  } catch (err: unknown) {
    if (err instanceof VectorError) throw err;
    throw new VectorError("E_ASSET_INTEGRITY");
  }

  if (!options.persistentCache) {
    throw new VectorError("E_ASSET_INTEGRITY");
  }

  await options.persistentCache.initialize(options.network === "allow" ? "online" : "offline");

  const verifiedCache = new VerifiedModelCache(options.assets, (logicalPath: string) =>
    options.persistentCache!.read(logicalPath)
  );

  return {
    cache: verifiedCache,
    wasmUrl,
    factoryUrl,
    codecs: { jpeg, png, resize }
  };
}

/**
 * 処理名: ブラウザ GPU アダプター設定
 * 処理概要: WebGPU バックエンド選択時に adapter を明示取得して ONNX Runtime env へ設定する。
 * 実装理由: WebGPU アダプターを明示的に注入し、自動フォールバックを防止するため。
 * @param runtime - ポータブルランタイム。
 * @param backend - バックエンド種別。
 * @param gpu - GPU API オブジェクト (省略時は navigator.gpu)。
 */
export async function configureBrowserGpu(
  runtime: PortableRuntime,
  backend: string,
  gpu?: { requestAdapter: () => Promise<unknown> }
): Promise<void> {
  if (backend !== "webgpu") {
    return;
  }
  const gpuApi = gpu ?? (typeof navigator !== "undefined" ? (navigator as unknown as { gpu?: { requestAdapter: () => Promise<unknown> } }).gpu : undefined);
  if (!gpuApi || typeof gpuApi.requestAdapter !== "function") {
    throw new VectorError("E_ENVIRONMENT");
  }

  const adapter = await gpuApi.requestAdapter();
  if (!adapter) {
    throw new VectorError("E_ENVIRONMENT");
  }

  const onnxBackends = (runtime.env.backends as Record<string, unknown>)?.onnx as Record<string, unknown>;
  const webgpuEnv = (onnxBackends?.webgpu as Record<string, unknown>) ?? {};
  webgpuEnv.adapter = adapter;
  onnxBackends.webgpu = webgpuEnv;
}
