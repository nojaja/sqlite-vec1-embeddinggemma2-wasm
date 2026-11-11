import { VectorError } from "../errors";
import {
  MODEL_REPOSITORY,
  MODEL_REVISION,
  ModelAssetDigest,
  validateModelAssets
} from "./model-contract";

/**
 * 処理名: SHA-256 16進文字列計算
 * 処理概要: Web Crypto API を用いて入力バイナリの SHA-256 ダイジェストを計算する。
 * 実装理由: Node.js およびブラウザ環境双方で外部依存なしに完全性検証を行うため。
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
 * 処理名: 許可されるキャッシュキープレフィックス定数
 */
const PREFIX_LOCAL = `/models/${MODEL_REPOSITORY}/`;
const PREFIX_REMOTE = `https://huggingface.co/${MODEL_REPOSITORY}/resolve/${MODEL_REVISION}/`;

/**
 * 処理名: VerifiedModelCache クラス
 * 処理概要: Transformers.js のモデル読み込みキーを検証済みモデル資材へ写像し、完全性を保証して Response を返す。
 * 実装理由: 不正なURLや破損したキャッシュファイルの読み込みを防止し、決定論的な推論ランタイム環境を提供するため。
 */
export class VerifiedModelCache {
  private readonly assetMap = new Map<string, ModelAssetDigest>();
  private readonly reader: (path: string) => Promise<Uint8Array | undefined>;

  /**
   * 処理名: VerifiedModelCache コンストラクタ
   * 処理概要: 資材一覧を検証し、パスごとの期待サイズおよびハッシュ値をマップに保持する。
   * 実装理由: 読み取りごとのハッシュ検証基盤を構築するため。
   * @param assets - 検証対象の資材ダイジェスト一覧。
   * @param reader - 実資材読み込み非同期関数。
   */
  constructor(
    assets: readonly ModelAssetDigest[],
    reader: (path: string) => Promise<Uint8Array | undefined>
  ) {
    validateModelAssets(assets);
    for (const a of assets) {
      this.assetMap.set(a.path, a);
    }
    this.reader = reader;
  }

  /**
   * 処理名: 要求キーの論理パス解決
   * 処理概要: URL またはローカルパスから正規化されたマニフェスト論理パスを抽出する。
   * 実装理由: 許可された 2 プレフィックス以外の任意リクエストやパストラバーサルを遮断するため。
   * @param request - リクエスト文字列または Request オブジェクト。
   * @returns 解決された論理パス、または未許可キーの場合 undefined。
   */
  private resolveLogicalPath(request: string | Request): string | undefined {
    const urlStr = typeof request === "string" ? request : request.url;
    let relPath: string | undefined;

    if (urlStr.startsWith(PREFIX_LOCAL)) {
      relPath = urlStr.slice(PREFIX_LOCAL.length);
    } else if (urlStr.startsWith(PREFIX_REMOTE)) {
      relPath = urlStr.slice(PREFIX_REMOTE.length);
    } else {
      return undefined;
    }

    if (relPath.includes("..") || relPath.includes("%2e") || relPath.includes("%2E")) {
      return undefined;
    }
    if (!this.assetMap.has(relPath)) {
      return undefined;
    }
    return relPath;
  }

  /**
   * 処理名: キャッシュマッチング (読み込み)
   * 処理概要: リクエストに対応する資材を reader から読み取り、サイズとハッシュを検証して Response を返す。
   * 実装理由: 読み取りごとに毎度完全性を照合し、破損資材の混入を防ぐため。
   * @param request - リクエストキー。
   * @returns 検証済み Response、またはキャッシュミスの場合は undefined。
   */
  public async match(request: string | Request): Promise<Response | undefined> {
    const logicalPath = this.resolveLogicalPath(request);
    if (!logicalPath) {
      return undefined;
    }
    const expected = this.assetMap.get(logicalPath)!;
    const data = await this.reader(logicalPath);
    if (data === undefined) {
      return undefined;
    }

    if (data.byteLength !== expected.bytes) {
      throw new VectorError("E_ASSET_INTEGRITY");
    }
    const sha = await sha256Hex(data);
    if (sha.toLowerCase() !== expected.sha256.toLowerCase()) {
      throw new VectorError("E_ASSET_INTEGRITY");
    }

    let mime = "application/octet-stream";
    if (logicalPath.endsWith(".json")) {
      mime = "application/json";
    } else if (logicalPath.endsWith(".jinja")) {
      mime = "text/plain";
    }

    const copy = new Uint8Array(data);
    return new Response(copy, {
      headers: {
        "Content-Length": String(copy.byteLength),
        "Content-Type": mime
      }
    });
  }

  /**
   * 処理名: キャッシュ格納検証 (put)
   * 処理概要: 格納対象の Response 内容が定義されたダイジェストと完全に一致することを検証する。
   * 実装理由: 不正なレスポンスによるキャッシュ汚染を防止するため。
   * @param request - 格納先リクエストキー。
   * @param response - 格納対象 Response。
   * @returns 完了 Promise。
   */
  public async put(request: string | Request, response: Response): Promise<void> {
    const logicalPath = this.resolveLogicalPath(request);
    if (!logicalPath) {
      throw new VectorError("E_ASSET_INTEGRITY");
    }
    const expected = this.assetMap.get(logicalPath)!;
    const buf = new Uint8Array(await response.arrayBuffer());
    if (buf.byteLength !== expected.bytes) {
      throw new VectorError("E_ASSET_INTEGRITY");
    }
    const sha = await sha256Hex(buf);
    if (sha.toLowerCase() !== expected.sha256.toLowerCase()) {
      throw new VectorError("E_ASSET_INTEGRITY");
    }
  }
}
