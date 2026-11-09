import { VectorError } from "../errors";
import { validateModelAssets, type ModelAssetDigest } from "./model-contract";

/**
 * 処理名: 資材ライターインターフェース
 * 処理概要: ストリーム書き込み、クローズ、アボートメソッドを定義する。
 * 実装理由: キャッシュ保存時のアトミックな書き込みライフサイクルを抽象化するため。
 */
export interface ArtifactWriter {
  /**
   * 処理名: チャンク書き込み
   * 処理概要: バイナリチャンクをストレージへ追記する。
   * 実装理由: 分割ストリームデータを順次書き込むため。
   * @param chunk - 書き込むバイト配列。
   */
  write(chunk: Uint8Array): Promise<void>;
  /**
   * 処理名: 書き込み完了クローズ
   * 処理概要: 書き込みを完了しリソースをフラッシュして閉じる。
   * 実装理由: 正常終了時のファイル確定を行うため。
   */
  close(): Promise<void>;
  /**
   * 処理名: 書き込み破棄アボート
   * 処理概要: 書き込み途中のテンポラリリソースを破棄する。
   * 実装理由: エラー発生時に不完全な一時ファイルを残さないため。
   */
  abort(): Promise<void>;
}

/**
 * 処理名: 永続キャッシュストレージインターフェース
 * 処理概要: ファイルの存在確認、読み出し、ダイジェスト取得、ライター生成、コミット、削除、排他制御を定義する。
 * 実装理由: プラットフォームごとのファイルシステムやOPFSストレージ操作を抽象化するため。
 */
export interface PersistentCacheStorage {
  /**
   * 処理名: ファイル存在確認
   * 処理概要: 指定パスに通常ファイルが存在するか確認する。
   * 実装理由: 資材の配置状況を判定するため。
   * @param path - 論理パス。
   * @returns 存在真偽値。
   */
  exists(path: string): Promise<boolean>;
  /**
   * 処理名: 資材バイナリ読み出し
   * 処理概要: 指定パスのファイル内容を全件読み出す。
   * 実装理由: キャッシュ済み資材をメモリへ読み込むため。
   * @param path - 論理パス。
   * @returns バイト配列またはundefined。
   */
  read(path: string): Promise<Uint8Array | undefined>;
  /**
   * 処理名: 資材ダイジェスト取得
   * 処理概要: 指定パスのバイトサイズとSHA-256ハッシュを計算して返す。
   * 実装理由: 保存済み資材の破損や不整合を検出するため。
   * @param path - 論理パス。
   * @returns サイズとハッシュのオブジェクトまたはundefined。
   */
  digest(path: string): Promise<{ bytes: number; sha256: string } | undefined>;
  /**
   * 処理名: 資材ライター生成
   * 処理概要: 指定パスへの書き込みストリームライターを生成する。
   * 実装理由: 新規資材のアトミックな保存を開始するため。
   * @param path - 保存先論理パス。
   * @returns ArtifactWriterインスタンス。
   */
  createWriter(path: string): Promise<ArtifactWriter>;
  /**
   * 処理名: 一時資材アトミックコミット
   * 処理概要: ステージング資材を本番配置先パスへ移動・確定する。
   * 実装理由: 不完全な状態での公開を防ぎアトミックに反映するため。
   * @param source - 移動元パス。
   * @param target - 移動先パス。
   */
  commit(source: string, target: string): Promise<void>;
  /**
   * 処理名: ディレクトリツリー削除
   * 処理概要: 指定プレフィックス配下の全資材を再帰的に削除する。
   * 実装理由: キャッシュセットの無効化や破棄を一括実行するため。
   * @param prefix - 削除対象プレフィックス。
   */
  removeTree(prefix: string): Promise<void>;
  /**
   * 処理名: 排他制御実行
   * 処理概要: キーごとに排他ロックを取得して非同期処理を実行する。
   * 実装理由: 複数ワーカーや並行処理間でのキャッシュ競合破損を防ぐため。
   * @param key - ロック識別キー。
   * @param action - 排他下で実行する非同期関数。
   * @returns アクションの戻り値。
   */
  runExclusive<T>(key: string, action: () => Promise<T>): Promise<T>;
}

/**
 * 処理名: モデルキャッシュ初期化モード型定義
 * 処理概要: キャッシュ初期化時のネットワーク動作モード(online/cold/offline)を定義する。
 * 実装理由: ネットワーク接続制限ポリシーを厳格に適用するため。
 */
export type ModelCacheMode = "online" | "cold" | "offline";

/**
 * 処理名: 資材取得関数型定義
 * 処理概要: モデル資材情報を受け取りリモートまたはローカルからHTTPレスポンスを取得する関数を定義する。
 * 実装理由: ダウンロード処理の外部注入を可能にするため。
 */
export type AssetFetcher = (asset: ModelAssetDigest) => Promise<Response>;

/**
 * 処理名: 永続モデルキャッシュオプションインターフェース
 * 処理概要: 資材ダイジェスト配列、セットハッシュ、マニフェストハッシュ、ストレージアダプタ等を定義する。
 * 実装理由: キャッシュ管理クラスの生成パラメータを型安全に受け渡すため。
 */
export interface PersistentModelCacheOptions {
  assets: readonly ModelAssetDigest[];
  artifactSetHash: string;
  manifestHash: string;
  storage: PersistentCacheStorage;
  fetcher?: AssetFetcher;
  chunkSize?: number;
}

const MARKER_LIMIT = 64 * 1024;
const HASH = /^[0-9a-f]{64}$/;

/**
 * 処理名: 永続model cache
 * 処理概要: 全11資材をstage経由で取得し、ready markerで公開する。
 * 実装理由: 部分集合を実行可能にせず、offline再利用を保証するため。
 */
export class PersistentModelCache {
  private readonly assets: readonly ModelAssetDigest[];
  private readonly setHash: string;
  private readonly manifestHash: string;
  private readonly storage: PersistentCacheStorage;
  private readonly fetcher: AssetFetcher | undefined;
  private readonly chunkSize: number;
  private ready = false;

  /**
   * 処理名: cache生成
   * 処理概要: 資材・hash・chunkSizeを検証し、manifestをcopy/freezeする。
   * 実装理由: remote manifestによる集合差替えを防ぐため。
   * @param options - 生成option。
   */
  public constructor(options: PersistentModelCacheOptions) {
    validateModelAssets(options.assets);
    if (!HASH.test(options.artifactSetHash) || !HASH.test(options.manifestHash)) throw new VectorError("E_ASSET_INTEGRITY");
    const chunkSize = options.chunkSize ?? 1024 * 1024;
    if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) throw new VectorError("E_ASSET_INTEGRITY");
    this.assets = Object.freeze(options.assets.map((asset) => Object.freeze({ path: asset.path, bytes: asset.bytes, sha256: asset.sha256 })));
    this.setHash = options.artifactSetHash;
    this.manifestHash = options.manifestHash;
    this.storage = options.storage;
    this.fetcher = options.fetcher;
    this.chunkSize = chunkSize;
  }

  /**
   * 処理名: ルートパス取得
   * 処理概要: モデル資材セットのストレージルートパスを返却する。
   * 実装理由: セットハッシュに基づいた一意の配置先ディレクトリパスを解決するため。
   * @returns ストレージルートパス。
   */
  private get root(): string { return `sets/${this.setHash}`; }

  /**
   * 処理名: marker bytes生成
   * 処理概要: schemaVersion1のmarker JSONをUTF-8で返す。
   * 実装理由: 順序込みで資材集合を照合するため。
   * @returns marker bytes。
   */
  private markerBytes(): Uint8Array {
    return new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, artifactSetHash: this.setHash, manifestHash: this.manifestHash, assets: this.assets }));
  }

  /**
   * 処理名: marker検証
   * 処理概要: markerが固定集合と完全一致するかを返す。
   * 実装理由: markerの存在だけを信頼しないため。
   * @param bytes - 保存済みmarker。
   * @returns 正常ならtrue。
   */
  private markerValid(bytes: Uint8Array): boolean {
    if (bytes.byteLength > MARKER_LIMIT) return false;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return text === new TextDecoder().decode(this.markerBytes()) && JSON.stringify(JSON.parse(text)) === text;
    } catch {
      return false;
    }
  }

  /**
   * 処理名: 公開file検証
   * 処理概要: 全資材のsize/SHA-256を保存値と照合する。
   * 実装理由: 公開file破損を検出するため。
   * @returns 全て正常ならtrue。
   */
  private async filesValid(): Promise<boolean> {
    for (const asset of this.assets) {
      const digest = await this.storage.digest(`${this.root}/files/${asset.path}`);
      if (digest === undefined || digest.bytes !== asset.bytes || digest.sha256 !== asset.sha256) return false;
    }
    return true;
  }

  /**
   * 処理名: 有界書込み
   * 処理概要: bytesをchunkSize以下に分割して書き込む。
   * 実装理由: 1回のwriteを上限内に保つため。
   * @param writer - 書込み先。
   * @param bytes - 書込みbytes。
   */
  private async writeBounded(writer: ArtifactWriter, bytes: Uint8Array): Promise<void> {
    for (let offset = 0; offset < bytes.byteLength; offset += this.chunkSize) await writer.write(bytes.subarray(offset, offset + this.chunkSize));
  }

  /**
   * 処理名: 小file書込み
   * 処理概要: state/marker等の小さなfileを分割して保存する。
   * 実装理由: writer lifecycleをabort付きで一箇所にまとめるため。
   * @param path - 保存先。
   * @param bytes - 内容。
   */
  private async putSmall(path: string, bytes: Uint8Array): Promise<void> {
    const writer = await this.storage.createWriter(path);
    try {
      await this.writeBounded(writer, bytes);
      await writer.close();
    } catch (error) {
      await writer.abort().catch(() => undefined);
      throw error;
    }
  }

  /**
   * 処理名: 資材1件取得
   * 処理概要: responseをstreamで読みbyte超過を止めてstageへ保存し、保存後digestを照合する。
   * 実装理由: 宣言と異なる資材を公開しないため。
   * @param fetcher - 取得関数。
   * @param asset - 資材定義。
   */
  private async acquireAsset(fetcher: AssetFetcher, asset: ModelAssetDigest): Promise<void> {
    const response = await fetcher(asset);
    if (!response.ok || response.body === null) throw new VectorError("E_ASSET_INTEGRITY");
    const reader = response.body.getReader();
    const stagePath = `${this.root}/stage/files/${asset.path}`;
    const writer = await this.storage.createWriter(stagePath);
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > asset.bytes) throw new VectorError("E_ASSET_INTEGRITY");
        await this.writeBounded(writer, value);
      }
      if (total !== asset.bytes) throw new VectorError("E_ASSET_INTEGRITY");
      await writer.close();
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      await writer.abort().catch(() => undefined);
      throw error;
    } finally {
      reader.releaseLock();
    }
    const digest = await this.storage.digest(stagePath);
    if (digest === undefined || digest.bytes !== asset.bytes || digest.sha256 !== asset.sha256) throw new VectorError("E_ASSET_INTEGRITY");
  }

  /**
   * 処理名: 取得と公開
   * 処理概要: stageへ全資材を取得し、files・markerの順にcommitしてstageを除去する。
   * 実装理由: 部分集合をREADYにしないため。
   * @param fetcher - 取得関数。
   */
  private async acquire(fetcher: AssetFetcher): Promise<void> {
    try {
      await this.putSmall(`${this.root}/stage/state.json`, new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, state: "acquiring" })));
      for (const asset of this.assets) await this.acquireAsset(fetcher, asset);
      await this.putSmall(`${this.root}/stage/ready.json`, this.markerBytes());
    } catch {
      throw new VectorError("E_ASSET_INTEGRITY");
    }
    for (const asset of this.assets) await this.storage.commit(`${this.root}/stage/files/${asset.path}`, `${this.root}/files/${asset.path}`);
    await this.storage.commit(`${this.root}/stage/ready.json`, `${this.root}/ready.json`);
    await this.storage.removeTree(`${this.root}/stage`);
  }

  /**
   * 処理名: 初期化
   * 処理概要: 保存状態とmodeに従い再利用・取得・拒否を決める。
   * 実装理由: 自動fallbackなしでonline/cold/offlineを区別するため。
   * @param mode - 初期化mode。
   */
  public async initialize(mode: ModelCacheMode): Promise<void> {
    await this.storage.runExclusive(this.setHash, async () => {
      const marker = await this.storage.read(`${this.root}/ready.json`);
      let corrupt = false;
      if (marker !== undefined) {
        corrupt = !this.markerValid(marker) || !(await this.filesValid());
        if (!corrupt) { this.ready = true; return; }
        if (mode !== "online") throw new VectorError("E_ASSET_INTEGRITY");
      }
      if (mode === "offline" || this.fetcher === undefined) throw new VectorError("E_MODEL_CACHE_MISS");
      if (await this.storage.exists(`${this.root}/stage/state.json`)) throw new VectorError("E_ASSET_INTEGRITY");
      await this.acquire(this.fetcher);
      this.ready = true;
    });
  }

  /**
   * 処理名: 明示復旧
   * 処理概要: 現在setのstageだけを排他的に削除しready=falseへ戻す。
   * 実装理由: 他setやDBを消さず障害証跡を暗黙削除しないため。
   */
  public async recover(): Promise<void> {
    await this.storage.runExclusive(this.setHash, async () => {
      await this.storage.removeTree(`${this.root}/stage`);
      this.ready = false;
    });
  }

  /**
   * 処理名: 資材読込み
   * 処理概要: 排他内でdigestを再確認しcopyを返す。未知pathはundefined。
   * 実装理由: markerの存在だけを信頼しないため。
   * @param path - manifest論理path。
   * @returns bytesまたはundefined。
   */
  public async read(path: string): Promise<Uint8Array | undefined> {
    const asset = this.assets.find((entry) => entry.path === path);
    if (asset === undefined) return undefined;
    if (!this.ready) throw new VectorError("E_MODEL_CACHE_MISS");
    return this.storage.runExclusive(this.setHash, async () => {
      const target = `${this.root}/files/${asset.path}`;
      const digest = await this.storage.digest(target);
      if (digest === undefined || digest.bytes !== asset.bytes || digest.sha256 !== asset.sha256) throw new VectorError("E_ASSET_INTEGRITY");
      const bytes = await this.storage.read(target);
      if (bytes === undefined || bytes.byteLength !== asset.bytes) throw new VectorError("E_ASSET_INTEGRITY");
      return bytes.slice();
    });
  }
}
