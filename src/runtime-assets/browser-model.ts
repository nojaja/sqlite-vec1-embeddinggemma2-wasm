import { VectorError } from "../errors";
import { ModelAssetDigest } from "./model-contract";

/**
 * 処理名: SHA-256 16進文字列計算
 * 処理概要: Web Crypto API を用いて入力バイナリの SHA-256 ダイジェストを計算する。
 * 実装理由: ブラウザ環境で外部依存なしに完全性検証を行うため。
 * @param data - 入力バイト列。
 * @returns 64文字の小文字16進ハッシュ。
 */
async function sha256Hex(data: Uint8Array): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * 処理名: 安全なブラウザ URL 判定
 * 処理概要: HTTPS またはループバックアドレス (localhost, 127.0.0.1, [::1]) の HTTP であり、認証情報・クエリ・ハッシュを含まないか判定する。
 * 実装理由: モデル取得先が改ざんされたり安全でないエンドポイントへ向かないようにするため。
 * @param parsedUrl - パース済み URL オブジェクト。
 * @returns 安全な URL であれば true。
 */
export function isSecureBrowserUrl(parsedUrl: URL): boolean {
  if (parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) {
    return false;
  }
  if (parsedUrl.protocol === "https:") {
    return true;
  }
  if (parsedUrl.protocol === "http:") {
    const host = parsedUrl.hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  }
  return false;
}

/**
 * 処理名: ブラウザモデルリーダー生成
 * 処理概要: マニフェスト資材、ベース URL、期待オリジンを検証し、サイズ・ハッシュ検証付きの reader 関数を返す。
 * 実装理由: オリジン越えや未検証モデルのブラウザ読み込みを完全排除するため。
 * @param assets - 許可されるモデル資材一覧。
 * @param baseUrl - モデル資材のベース URL。
 * @param expectedOrigin - パッケージ提供元の期待オリジン。
 * @param fetcher - fetch 関数 (省略時はグローバル fetch)。
 * @returns 資材読み出し非同期関数。
 */
export function createBrowserModelReader(
  assets: readonly ModelAssetDigest[],
  baseUrl: string,
  expectedOrigin: string,
  fetcher: typeof fetch = fetch
): (logicalPath: string) => Promise<Uint8Array | undefined> {
  if (!baseUrl.endsWith("/")) {
    throw new VectorError("E_ASSET_INTEGRITY");
  }

  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new VectorError("E_ASSET_INTEGRITY");
  }

  if (!isSecureBrowserUrl(parsed)) {
    throw new VectorError("E_ASSET_INTEGRITY");
  }

  if (parsed.origin !== expectedOrigin) {
    throw new VectorError("E_ASSET_INTEGRITY");
  }

  const assetMap = new Map<string, ModelAssetDigest>();
  for (const a of assets) {
    assetMap.set(a.path, a);
  }

  return async (logicalPath: string): Promise<Uint8Array | undefined> => {
    const expected = assetMap.get(logicalPath);
    if (!expected) {
      return undefined;
    }

    const targetUrl = `${baseUrl}${logicalPath}`;
    const res = await fetcher(targetUrl, {
      cache: "no-store",
      credentials: "omit"
    });

    const ab = await res.arrayBuffer();
    const bytes = new Uint8Array(ab);

    if (bytes.byteLength !== expected.bytes) {
      throw new VectorError("E_ASSET_INTEGRITY");
    }

    const sha = await sha256Hex(bytes);
    if (sha.toLowerCase() !== expected.sha256.toLowerCase()) {
      throw new VectorError("E_ASSET_INTEGRITY");
    }

    return new Uint8Array(bytes);
  };
}
