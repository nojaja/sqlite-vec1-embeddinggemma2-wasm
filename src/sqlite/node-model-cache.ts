import * as path from "node:path";
import * as os from "node:os";
import { VectorError } from "../errors";
import {
  MODEL_REPOSITORY,
  MODEL_REVISION,
  ModelAssetDigest
} from "../runtime-assets/model-contract";
import { PersistentModelCache } from "../runtime-assets/persistent-model-cache";
import { createNodePersistentCacheStorage } from "../runtime-assets/node-persistent-cache-storage";
import { VerifiedModelCache } from "../runtime-assets/verified-cache";

/**
 * 処理名: 既定 Node モデルベース URL 定数
 * 処理概要: Hugging Face 固定リビジョン上の EmbeddingGemma 2 モデルルート URL を定義する。
 * 実装理由: Node 実行時の正準なモデル資材ダウンロード出元を固定するため。
 */
export const DEFAULT_NODE_MODEL_BASE_URL =
  `https://huggingface.co/${MODEL_REPOSITORY}/resolve/${MODEL_REVISION}/`;

/**
 * 処理名: Node モデルフェッチャー生成
 * 処理概要: ベース URL を検証し、資材ごとの固定オプション付き fetch を行う関数を返す。
 * 実装理由: 危険な URL やリダイレクトを遮断し、安全な HTTP ストリーム取得を行うため。
 * @param baseUrl - モデルベース URL。
 * @param fetcher - fetch 関数 (省略時はグローバル fetch)。
 * @returns 資材ごとの Response を返す非同期関数。
 */
export function createNodeModelFetcher(
  baseUrl: string,
  fetcher: typeof fetch = fetch
): (asset: ModelAssetDigest) => Promise<Response> {
  if (typeof baseUrl !== "string" || !baseUrl.endsWith("/")) {
    throw new VectorError("E_INPUT");
  }

  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new VectorError("E_INPUT");
  }

  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new VectorError("E_INPUT");
  }

  if (parsed.protocol === "https:") {
    // 許可
  } else if (parsed.protocol === "http:") {
    const host = parsed.hostname;
    if (host !== "localhost" && host !== "127.0.0.1" && host !== "[::1]") {
      throw new VectorError("E_INPUT");
    }
  } else {
    throw new VectorError("E_INPUT");
  }

  return async (asset: ModelAssetDigest): Promise<Response> => {
    const targetUrl = new URL(asset.path, baseUrl);
    return fetcher(targetUrl, {
      redirect: "error",
      credentials: "omit",
      cache: "no-store"
    });
  };
}

/**
 * 処理名: Node モデルキャッシュ設定オプション
 * 処理概要: キャッシュ先、ネットワークポリシー、ベースURL、資材一覧、ハッシュ値を保持する型。
 */
export interface NodeModelCacheOptions {
  cacheDirectory?: string;
  network: "allow" | "offline";
  baseUrl?: string;
  assets: readonly ModelAssetDigest[];
  artifactSetHash: string;
  manifestHash: string;
}

/**
 * 処理名: Node モデルキャッシュ事前準備
 * 処理概要: 永続モデルキャッシュを初期化し、Transformers.js 用の VerifiedModelCache を生成する。
 * 実装理由: 推論実行前にモデル資材の完全性を検証し、オフライン・オンライン双方で安定動作させるため。
 * @param options - キャッシュ初期化オプション。
 * @param fetcher - fetch 実装 (テスト用モック注入可能)。
 * @returns 検証済み VerifiedModelCache インスタンス。
 */
export async function prepareNodeModelCache(
  options: NodeModelCacheOptions,
  fetcher: typeof fetch = fetch
): Promise<VerifiedModelCache> {
  let cacheDir = options.cacheDirectory;
  if (!cacheDir) {
    const localApp = process.env.LOCALAPPDATA;
    const xdg = process.env.XDG_CACHE_HOME;
    if (localApp) {
      cacheDir = path.join(localApp, "sqlite-vec1-embeddinggemma2-wasm", "model");
    } else if (xdg) {
      cacheDir = path.join(xdg, "sqlite-vec1-embeddinggemma2-wasm", "model");
    } else {
      cacheDir = path.join(os.homedir(), ".cache", "sqlite-vec1-embeddinggemma2-wasm", "model");
    }
  }

  const storage = await createNodePersistentCacheStorage(cacheDir);
  const baseUrl = options.baseUrl ?? DEFAULT_NODE_MODEL_BASE_URL;
  const nodeFetcher = options.network === "allow" ? createNodeModelFetcher(baseUrl, fetcher) : undefined;

  const persistentCache = new PersistentModelCache({
    assets: options.assets,
    artifactSetHash: options.artifactSetHash,
    manifestHash: options.manifestHash,
    storage,
    fetcher: nodeFetcher
  });

  await persistentCache.initialize(options.network === "allow" ? "online" : "offline");

  return new VerifiedModelCache(options.assets, (logicalPath: string) =>
    persistentCache.read(logicalPath)
  );
}
