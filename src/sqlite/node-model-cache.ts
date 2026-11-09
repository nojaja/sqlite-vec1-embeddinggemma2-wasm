import { VectorError } from "../errors";
import { createNodePersistentCacheStorage } from "../runtime-assets/node-persistent-cache-storage";
import { MODEL_REPOSITORY, MODEL_REVISION, type ModelAssetDigest } from "../runtime-assets/model-contract";
import { PersistentModelCache } from "../runtime-assets/persistent-model-cache";
import { VerifiedModelCache } from "../runtime-assets/verified-cache";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * 処理名: Node既定モデルベースURL定数
 * 処理概要: Node環境における既定のHugging Faceモデル取得元URLを定義する。
 * 実装理由: 固定リポジトリおよびリビジョンからのモデル取得を一意にするため。
 */
export const DEFAULT_NODE_MODEL_BASE_URL = `https://huggingface.co/${MODEL_REPOSITORY}/resolve/${MODEL_REVISION}/`;

/**
 * 処理名: Nodeモデルキャッシュオプションインターフェース
 * 処理概要: Node環境でのモデルキャッシュ準備に必要なディレクトリやネットワーク設定を定義する。
 * 実装理由: キャッシュ初期化設定を型安全に受け渡すため。
 */
export interface NodeModelCacheOptions {
  cacheDirectory?: string;
  network: "allow" | "offline";
  baseUrl: string;
  assets: readonly ModelAssetDigest[];
  artifactSetHash: string;
  manifestHash: string;
}

/**
 * 処理名: 既定cache root解決
 * 処理概要: LOCALAPPDATA、XDG_CACHE_HOME、homedir/.cacheの順でmodel cache rootを返す。
 * 実装理由: model storageをDB領域から分離するため。
 * @returns cache root。
 */
function defaultCacheDirectory(): string {
  const base = process.env.LOCALAPPDATA ?? process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  return join(base, "sqlite-vec1-embeddinggemma2-wasm", "model");
}

/**
 * 処理名: Node model fetcher作成
 * 処理概要: HTTPS/loopback directoryだけから固定pathを取得する関数を返す。
 * 実装理由: 取得先を任意endpointへ変更させないため。
 * @param baseUrl - model資材root。
 * @param fetcher - fetch境界。
 * @returns 資材取得関数。
 */
export function createNodeModelFetcher(baseUrl: string, fetcher: typeof fetch = fetch): (asset: ModelAssetDigest) => Promise<Response> {
  let base: URL;
  try { base = new URL(baseUrl); } catch { throw new VectorError("E_INPUT"); }
  const secure = base.protocol === "https:" || (base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname));
  if (!secure || base.username !== "" || base.password !== "" || base.search !== "" || base.hash !== "" || !base.pathname.endsWith("/")) throw new VectorError("E_INPUT");
  return (asset) => fetcher(new URL(asset.path.split("/").map(encodeURIComponent).join("/"), base), { redirect: "error", credentials: "omit", cache: "no-store" });
}

/**
 * 処理名: Node model cache準備
 * 処理概要: 永続cacheを初期化してから検証済みcacheを返す。
 * 実装理由: VerifiedModelCache消費前に永続cacheをREADYにするため。
 * @param options - 準備option。
 * @param fetcher - fetch境界。
 * @returns 検証済みcache。
 */
export async function prepareNodeModelCache(options: NodeModelCacheOptions, fetcher: typeof fetch = fetch): Promise<VerifiedModelCache> {
  const storage = await createNodePersistentCacheStorage(options.cacheDirectory ?? defaultCacheDirectory());
  const persistent = new PersistentModelCache({
    assets: options.assets, artifactSetHash: options.artifactSetHash, manifestHash: options.manifestHash,
    storage, fetcher: createNodeModelFetcher(options.baseUrl, fetcher)
  });
  await persistent.initialize(options.network === "allow" ? "online" : "offline");
  return new VerifiedModelCache(options.assets, (path) => persistent.read(path));
}
