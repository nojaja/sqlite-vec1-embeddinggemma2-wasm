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
 * 処理名: リポジトリ解決オプション型
 * 処理概要: VerifiedModelCache が対象とするリポジトリ名とリビジョンを指定する。
 * 実装理由: 複数モデルで異なる Hugging Face リポジトリ・リビジョンプレフィックスを動的に構築するため。
 */
export interface VerifiedCacheRepoOptions {
  repository?: string;
  revision?: string;
  strictAllowlist?: boolean;
}

/**
 * 処理名: VerifiedModelCache クラス
 * 処理概要: Transformers.js のモデル読み込みキーを検証済みモデル資材へ写像し、完全性を保証して Response を返す。
 * 実装理由: 不正なURLや破損したキャッシュファイルの読み込みを防止し、決定論的な推論ランタイム環境を提供するため。
 */
export class VerifiedModelCache {
  private readonly assetMap = new Map<string, ModelAssetDigest>();
  private readonly reader: (path: string) => Promise<Uint8Array | undefined>;
  private readonly prefixLocal: string;
  private readonly prefixRemote: string;

  /**
   * 処理名: VerifiedModelCache コンストラクタ
   * 処理概要: 資材一覧を検証し、パスごとの期待サイズおよびハッシュ値をマップに保持する。
   * 実装理由: 読み取りごとのハッシュ検証基盤を構築するため。
   * @param assets - 検証対象の資材ダイジェスト一覧。
   * @param reader - 実資材読み込み非同期関数。
   * @param repoOptions - 対象モデルのリポジトリ・リビジョン設定（省略時は既定参照モデル）。
   */
  constructor(
    assets: readonly ModelAssetDigest[],
    reader: (path: string) => Promise<Uint8Array | undefined>,
    repoOptions?: VerifiedCacheRepoOptions
  ) {
    const repository = repoOptions?.repository ?? MODEL_REPOSITORY;
    const revision = repoOptions?.revision ?? MODEL_REVISION;
    const strict = repoOptions?.strictAllowlist ?? (repoOptions?.repository === undefined);
    this.prefixLocal = `/models/${repository}/`;
    this.prefixRemote = `https://huggingface.co/${repository}/resolve/${revision}/`;

    validateModelAssets(assets, { strictAllowlist: strict });
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

    if (urlStr.startsWith(this.prefixLocal)) {
      relPath = urlStr.slice(this.prefixLocal.length);
    } else if (urlStr.startsWith(this.prefixRemote)) {
      relPath = urlStr.slice(this.prefixRemote.length);
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

/**
 * 処理名: MultiModelVerifiedCache クラス
 * 処理概要: 複数モデルの VerifiedModelCache を登録・保持し、リクエスト URL に応じて適切なキャッシュへルーティングする。
 * 実装理由: 同一 Worker 内で異なるリポジトリ・リビジョンの複数モデルを衝突なく読み込むため。
 */
export class MultiModelVerifiedCache {
  private readonly caches: VerifiedModelCache[] = [];

  /**
   * 処理名: モデルキャッシュ登録
   * 処理概要: 個別モデル用の VerifiedModelCache をレジストリへ追加する。
   * 実装理由: 起動時およびオンデマンドロード時に利用可能なモデルキャッシュを順次登録するため。
   * @param cache - 登録する VerifiedModelCache インスタンス。
   */
  public register(cache: VerifiedModelCache): void {
    if (!this.caches.includes(cache)) {
      this.caches.push(cache);
    }
  }

  /**
   * 処理名: マルチモデルキャッシュ検索
   * 処理概要: 登録された各 VerifiedModelCache へ順に問い合わせ、最初に一致した Response を返す。
   * 実装理由: モデルごとに異なるプレフィックスを単一の customCache インターフェースで解決するため。
   * @param request - リクエスト文字列または Request。
   * @returns 一致した Response、または undefined。
   */
  public async match(request: string | Request): Promise<Response | undefined> {
    for (const cache of this.caches) {
      const res = await cache.match(request);
      if (res !== undefined) {
        return res;
      }
    }
    return undefined;
  }

  /**
   * 処理名: マルチモデルキャッシュ格納検証
   * 処理概要: リクエストに対応する登録キャッシュへ put を委譲する。
   * 実装理由: 不正なレスポンス書き込みを既存の完全性検証で拒否するため。
   * @param request - 格納先リクエストキー。
   * @param response - 格納対象 Response。
   */
  public async put(request: string | Request, response: Response): Promise<void> {
    for (const cache of this.caches) {
      const hit = await cache.match(request).catch(() => undefined);
      if (hit !== undefined) {
        await cache.put(request, response);
        return;
      }
    }
    throw new VectorError("E_ASSET_INTEGRITY");
  }
}
