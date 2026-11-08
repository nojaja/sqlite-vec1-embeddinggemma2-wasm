import { VectorError } from "../errors";
import { validateModelAssets, type ModelAssetDigest } from "./model-contract";

/** 成果物の書込み先。 */
export interface ArtifactWriter { write(chunk: Uint8Array): Promise<void>; close(): Promise<void>; abort(): Promise<void> }
/** 永続cacheの保存adapter。 */
export interface PersistentCacheStorage {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<Uint8Array | undefined>;
  digest(path: string): Promise<{ bytes: number; sha256: string } | undefined>;
  createWriter(path: string): Promise<ArtifactWriter>;
  commit(source: string, target: string): Promise<void>;
  removeTree(prefix: string): Promise<void>;
  runExclusive<T>(key: string, action: () => Promise<T>): Promise<T>;
}
/** cache初期化mode。 */
export type ModelCacheMode = "online" | "cold" | "offline";
/** 資材取得関数。 */
export type AssetFetcher = (asset: ModelAssetDigest) => Promise<Response>;
/** PersistentModelCacheのoption。 */
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
    } catch (error) {
      console.error("DEBUG ACQUIRE ERROR:", error);
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
