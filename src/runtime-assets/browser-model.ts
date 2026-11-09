import { VectorError } from "../errors";
import type { ModelAssetDigest } from "./model-contract";

/**
 * 処理名: ブラウザFetcher型定義
 * 処理概要: ブラウザ環境におけるfetch関数の型シグネチャを定義する。
 * 実装理由: モデル資材取得用のfetcher注入インターフェースを統一するため。
 */
export type BrowserFetcher = (input: string, init: RequestInit) => Promise<Response>;

/**
 * 処理名: browser URL安全性判定
 * 処理概要: HTTPSまたはloopbackのHTTPだけを許可する。
 * 実装理由: 非secure originからmodelやWasmを取得しないため。
 * @param url - 判定対象。
 * @returns 許可ならtrue。
 */
export function isSecureBrowserUrl(url: URL): boolean {
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

/**
 * 処理名: SHA-256 hex
 * 処理概要: Web Cryptoでdigestを計算する。
 * 実装理由: node:cryptoをbrowser bundleへ含めないため。
 * @param bytes - 対象bytes。
 * @returns 小文字hex。
 */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice()));
  return Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");
}

/**
 * 処理名: browser model reader作成
 * 処理概要: 固定資材だけを同一originから取得しsize/SHA-256を検証して返す。
 * 実装理由: HTTP成功を検証済み資材として扱わないため。
 * @param assets - 固定資材digest。
 * @param baseUrl - model資材root。
 * @param expectedOrigin - package提供origin。
 * @param fetcher - fetch境界。
 * @returns path別reader。
 */
export function createBrowserModelReader(
  assets: readonly ModelAssetDigest[],
  baseUrl: string,
  expectedOrigin: string,
  fetcher: BrowserFetcher = (input, init) => fetch(input, init)
): (path: string) => Promise<Uint8Array | undefined> {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new VectorError("E_ASSET_INTEGRITY");
  }
  const valid = isSecureBrowserUrl(base) && base.username === "" && base.password === "" && base.search === "" && base.hash === ""
    && base.pathname.endsWith("/") && base.origin === expectedOrigin;
  if (!valid) throw new VectorError("E_ASSET_INTEGRITY");
  const known = new Map(assets.map((asset) => [asset.path, asset]));
  return async (path: string): Promise<Uint8Array | undefined> => {
    const asset = known.get(path);
    if (asset === undefined) return undefined;
    const url = new URL(path.split("/").map(encodeURIComponent).join("/"), base).href;
    const response = await fetcher(url, { cache: "no-store", credentials: "omit", redirect: "error" });
    if (!response.ok) throw new VectorError("E_ASSET_INTEGRITY");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength !== asset.bytes || (await sha256Hex(bytes)) !== asset.sha256) throw new VectorError("E_ASSET_INTEGRITY");
    return bytes;
  };
}
