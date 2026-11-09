import { VectorError } from "../errors";
import { VerifiedModelCache } from "../runtime-assets/verified-cache";
import type { ModelAssetDigest } from "../runtime-assets/model-contract";
import { createBrowserOpfsPersistentCacheStorage } from "../runtime-assets/browser-opfs-cache-storage";
import { PersistentModelCache, type PersistentCacheStorage } from "../runtime-assets/persistent-model-cache";
import { createBrowserModelReader, isSecureBrowserUrl, type BrowserFetcher } from "../runtime-assets/browser-model";
import type { ImageCodecBytes } from "./image-codecs";
import type { PortableRuntime } from "./engine";

/**
 * 処理名: ブラウザ永続キャッシュインターフェース
 * 処理概要: ブラウザ環境におけるモデル初期化および読み出しメソッドを定義する。
 * 実装理由: OPFS永続キャッシュの抽象境界を定義するため。
 */
export interface BrowserPersistentModelCache {
  /**
   * 処理名: キャッシュ初期化
   * 処理概要: オンラインまたはオフラインモードでキャッシュストレージを初期化する。
   * 実装理由: 実行モードに応じた資材取得・検証を行うため。
   * @param mode - ネットワークモード。
   */
  initialize(mode: "online" | "offline"): Promise<void>;
  /**
   * 処理名: 資材読み出し
   * 処理概要: 指定パスの検証済み資材バイト配列を読み出す。
   * 実装理由: 推論実行に必要なモデルデータを供給するため。
   * @param path - 資材の論理パス。
   * @returns 資材バイナリまたはundefined。
   */
  read(path: string): Promise<Uint8Array | undefined>;
}

/**
 * 処理名: ブラウザ推論準備パラメータインターフェース
 * 処理概要: ブラウザでの推論実行に必要な各種URL、ハッシュ、フェッチャー、ストレージ設定を定義する。
 * 実装理由: ブラウザ環境向け初期化入力を型安全に受け渡すため。
 */
export interface BrowserInferencePreparation {
  workerUrl: string;
  modelBaseUrl: string;
  backend: "wasm" | "webgpu";
  network: "allow" | "offline";
  artifactSetHash: string;
  manifestHash: string;
  assets: readonly ModelAssetDigest[];
  fetcher?: BrowserFetcher;
  storage?: PersistentCacheStorage;
  persistentCache?: BrowserPersistentModelCache;
}

/**
 * 処理名: 準備済みブラウザ推論成果物インターフェース
 * 処理概要: 検証済みキャッシュ、Wasm/JS URL、画像コーデックバイナリを保持する。
 * 実装理由: 推論エンジン初期化に必要な成果物を構造化して返すため。
 */
export interface PreparedBrowserInference {
  cache: VerifiedModelCache;
  wasmUrl: string;
  factoryUrl: string;
  codecs: ImageCodecBytes;
}

/**
 * 処理名: WebGPUアダプター要求インターフェース
 * 処理概要: WebGPUのrequestAdapterメソッドシグネチャを定義する。
 * 実装理由: navigator.gpuまたはテスト用モックを型安全に注入するため。
 */
export interface WebGpuProvider {
  /**
   * 処理名: GPUアダプター要求
   * 処理概要: システムのGPUアダプターを非同期に取得する。
   * 実装理由: WebGPU推論バックエンドのアダプターを取得するため。
   * @returns GPUアダプターまたはnull。
   */
  requestAdapter(): Promise<unknown>;
}

const CODEC_LIMIT = 32 * 1024 * 1024;

/**
 * 処理名: package資材取得
 * 処理概要: 非空かつ32MiB以下のcodec Wasmを取得する。
 * 実装理由: model用hash契約と区別したpackage資材検証のため。
 * @param fetcher - fetch境界。
 * @param url - 取得URL。
 * @returns bytes。
 */
async function fetchPackageAsset(fetcher: BrowserFetcher, url: URL): Promise<Uint8Array> {
  const response = await fetcher(url.href, { cache: "no-store", credentials: "omit", redirect: "error" });
  if (!response.ok) throw new VectorError("E_ASSET_INTEGRITY");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > CODEC_LIMIT) throw new VectorError("E_ASSET_INTEGRITY");
  return bytes;
}

/**
 * 処理名: browser推論準備
 * 処理概要: 永続cacheを先に準備し、同origin codecとvariant別ORT URLを解決する。
 * 実装理由: Worker初期化を部分資材や任意originで継続しないため。
 * @param options - 準備入力。
 * @returns 準備結果。
 */
export async function prepareBrowserInference(options: BrowserInferencePreparation): Promise<PreparedBrowserInference> {
  let worker: URL;
  try {
    worker = new URL(options.workerUrl);
  } catch {
    throw new VectorError("E_ASSET_INTEGRITY");
  }
  if (!isSecureBrowserUrl(worker)) throw new VectorError("E_ASSET_INTEGRITY");
  const fetcher: BrowserFetcher = options.fetcher ?? ((input, init) => fetch(input, init));
  createBrowserModelReader(options.assets, options.modelBaseUrl, worker.origin, fetcher);
  /**
   * 処理名: 永続キャッシュ用資材取得
   * 処理概要: モデルベースURLから資材をfetcher経由で取得する。
   * 実装理由: PersistentModelCacheのfetcherインターフェースへ適合させるため。
   * @param asset - 取得対象の資材ダイジェスト。
   * @returns 取得レスポンスPromise。
   */
  const assetFetcher = (asset: ModelAssetDigest) =>
    fetcher(new URL(asset.path.split("/").map(encodeURIComponent).join("/"), options.modelBaseUrl).href, {
      cache: "no-store",
      credentials: "omit",
      redirect: "error"
    });
  const persistent = options.persistentCache ?? new PersistentModelCache({
    assets: options.assets,
    artifactSetHash: options.artifactSetHash,
    manifestHash: options.manifestHash,
    storage: options.storage ?? await createBrowserOpfsPersistentCacheStorage(),
    fetcher: assetFetcher
  });
  await persistent.initialize(options.network === "allow" ? "online" : "offline");
  const variant = options.backend === "webgpu" ? "jspi" : "jsep";
  const codecs = {
    jpeg: await fetchPackageAsset(fetcher, new URL("../image/jpeg.wasm", worker)),
    png: await fetchPackageAsset(fetcher, new URL("../image/png.wasm", worker)),
    resize: await fetchPackageAsset(fetcher, new URL("../image/resize.wasm", worker))
  };
  return {
    cache: new VerifiedModelCache(options.assets, (path) => persistent.read(path)),
    wasmUrl: new URL(`../ort/ort-wasm-simd-threaded.${variant}.wasm`, worker).href,
    factoryUrl: new URL(`../ort/ort-wasm-simd-threaded.${variant}.mjs`, worker).href,
    codecs
  };
}

/**
 * 処理名: browser GPU明示設定
 * 処理概要: WebGPU指定時だけadapterを取得してORT envへ設定する。
 * 実装理由: 取得不能を環境エラーにし自動fallbackしないため。
 * @param runtime - 外部runtime。
 * @param backend - backend。
 * @param gpu - requestAdapterを持つ境界。省略時navigator.gpu。
 */
export async function configureBrowserGpu(runtime: PortableRuntime, backend: "wasm" | "webgpu", gpu?: WebGpuProvider): Promise<void> {
  if (backend !== "webgpu") return;
  const source = gpu ?? (navigator as unknown as { gpu?: WebGpuProvider }).gpu;
  const adapter = source === undefined ? null : await source.requestAdapter();
  if (adapter === null) throw new VectorError("E_ENVIRONMENT");
  const onnx = runtime.env.backends.onnx as Record<string, unknown>;
  onnx.webgpu = { ...(onnx.webgpu as object | undefined), adapter };
}
