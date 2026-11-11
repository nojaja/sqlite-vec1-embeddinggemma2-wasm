import { VectorError } from "../errors";
import { ModelAssetDigest, validateModelAssets } from "./model-contract";

/**
 * 処理名: モデルキャッシュモード型
 * 処理概要: オンライン取得、コールド取得、オフライン限定利用の各モードを定義する。
 * 実装理由: ネットワークポリシーに応じた厳格なキャッシュ挙動を制御するため。
 */
export type ModelCacheMode = "online" | "cold" | "offline";

/**
 * 処理名: 成果物ライターインターフェース
 * 処理概要: チャンク単位の書き込み、クローズ、アボートを提供する。
 * 実装理由: バッファ境界を制御した決定論的ファイル保存のため。
 */
export interface ArtifactWriter {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

/**
 * 処理名: 永続キャッシュストレージインターフェース
 * 処理概要: 存在確認、読み出し、ダイジェスト計算、ライター生成、コミット、ツリー削除、排他実行を提供する。
 * 実装理由: Node.js (fs) およびブラウザ (OPFS) 間の抽象ストレージ境界を定義するため。
 */
export interface PersistentCacheStorage {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<Uint8Array | undefined>;
  digest(path: string): Promise<{ bytes: number; sha256: string } | undefined>;
  createWriter(path: string): Promise<ArtifactWriter>;
  commit(source: string, target: string): Promise<void>;
  removeTree(prefix: string): Promise<void>;
  runExclusive<T>(key: string, action: () => Promise<T>): Promise<T>;
}

/**
 * 処理名: 永続モデルキャッシュ初期化オプション
 * 処理概要: 資材ダイジェスト、ハッシュ識別子、ストレージアダプター、取得関数、チャンクサイズを定義する。
 * 実装理由: キャッシュ構築に必要なパラメータを一括注入するため。
 */
export interface PersistentModelCacheOptions {
  assets: readonly ModelAssetDigest[];
  artifactSetHash: string;
  manifestHash: string;
  storage: PersistentCacheStorage;
  fetcher?: (asset: ModelAssetDigest) => Promise<Response>;
  chunkSize?: number;
}

const HASH_REGEX = /^[0-9a-f]{64}$/;

/**
 * 処理名: チャンク分割書き込みヘルパー
 * 処理概要: バイト配列を chunkSize 以下のチャンクに分割してライターへ順次書き込む。
 * 実装理由: メタデータや状態ファイルも含めすべての書き込みが容量上限を超えないようにするため。
 * @param writer - 対象ライター。
 * @param data - 書き込みデータ。
 * @param chunkSize - 最大チャンクサイズ。
 */
async function writeInChunks(
  writer: ArtifactWriter,
  data: Uint8Array,
  chunkSize: number
): Promise<void> {
  let offset = 0;
  while (offset < data.length) {
    const sliceLen = Math.min(chunkSize, data.length - offset);
    await writer.write(data.subarray(offset, offset + sliceLen));
    offset += sliceLen;
  }
}

/**
 * 処理名: PersistentModelCache クラス
 * 処理概要: ステージング・アトミックコミット・整合性検証を統合した永続モデルキャッシュ管理を提供する。
 * 実装理由: 不完全なモデル資材の利用を防止し、オフライン・オンライン双方で高信頼なキャッシュを運用するため。
 */
export class PersistentModelCache {
  private readonly assets: readonly ModelAssetDigest[];
  private readonly assetMap = new Map<string, ModelAssetDigest>();
  private readonly artifactSetHash: string;
  private readonly manifestHash: string;
  private readonly storage: PersistentCacheStorage;
  private readonly fetcher?: (asset: ModelAssetDigest) => Promise<Response>;
  private readonly chunkSize: number;
  private isReady = false;

  /**
   * 処理名: PersistentModelCache コンストラクタ
   * 処理概要: マニフェスト資材ホワイトリスト、ハッシュ値、チャンクサイズを検証して初期化する。
   * 実装理由: 不正なハッシュや欠損資材によるキャッシュ初期化を遮断するため。
   * @param options - キャッシュオプション。
   */
  constructor(options: PersistentModelCacheOptions) {
    validateModelAssets(options.assets);
    if (!HASH_REGEX.test(options.artifactSetHash) || !HASH_REGEX.test(options.manifestHash)) {
      throw new VectorError("E_ASSET_INTEGRITY");
    }
    const chunk = options.chunkSize ?? 1024 * 1024;
    if (!Number.isSafeInteger(chunk) || chunk <= 0) {
      throw new VectorError("E_ASSET_INTEGRITY");
    }

    this.assets = [...options.assets];
    for (const a of this.assets) {
      this.assetMap.set(a.path, a);
    }
    this.artifactSetHash = options.artifactSetHash;
    this.manifestHash = options.manifestHash;
    this.storage = options.storage;
    this.fetcher = options.fetcher;
    this.chunkSize = chunk;
  }

  /**
   * 処理名: 既存資材完全性検証
   * 処理概要: 公開ディレクトリ配下の全 11 資材のサイズと SHA-256 ダイジェストを照合する。
   * 実装理由: 破損資材の早期検知およびオフラインモードでの整合性保証のため。
   * @returns 全資材が完全であれば true。
   */
  private async checkAllAssetsValid(): Promise<boolean> {
    for (const asset of this.assets) {
      const filePath = `sets/${this.artifactSetHash}/files/${asset.path}`;
      const d = await this.storage.digest(filePath);
      if (!d || d.bytes !== asset.bytes || d.sha256.toLowerCase() !== asset.sha256.toLowerCase()) {
        return false;
      }
    }
    return true;
  }

  /**
   * 処理名: 単一資材ストリーム取得
   * 処理概要: fetcher からレスポンスをストリーム取得し、チャンクサイズ以下でライターへ書き込む。
   * 実装理由: 大容量ファイルの一括メモリ展開を回避し、書き込みバッファ上限を遵守するため。
   * @param asset - 取得対象資材。
   */
  private async fetchAndStageAsset(asset: ModelAssetDigest): Promise<void> {
    if (!this.fetcher) {
      throw new VectorError("E_MODEL_CACHE_MISS");
    }
    const res = await this.fetcher(asset);
    const stageFilePath = `sets/${this.artifactSetHash}/stage/files/${asset.path}`;
    const writer = await this.storage.createWriter(stageFilePath);

    try {
      const reader = res.body?.getReader();
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            let offset = 0;
            while (offset < value.length) {
              const sliceLen = Math.min(this.chunkSize, value.length - offset);
              await writer.write(value.subarray(offset, offset + sliceLen));
              offset += sliceLen;
            }
          }
        }
      } else {
        const buf = new Uint8Array(await res.arrayBuffer());
        let offset = 0;
        while (offset < buf.length) {
          const sliceLen = Math.min(this.chunkSize, buf.length - offset);
          await writer.write(buf.subarray(offset, offset + sliceLen));
          offset += sliceLen;
        }
      }
      await writer.close();
    } catch (err) {
      await writer.abort();
      throw err;
    }

    const d = await this.storage.digest(stageFilePath);
    if (!d || d.bytes !== asset.bytes || d.sha256.toLowerCase() !== asset.sha256.toLowerCase()) {
      throw new VectorError("E_ASSET_INTEGRITY");
    }
  }

  /**
   * 処理名: キャッシュ初期化実行
   * 処理概要: 指定モード（online, cold, offline）に従い、排他制御下で資材の検証またはダウンロード・コミットを行う。
   * 実装理由: 並行呼び出しでの二重ダウンロードを防ぎ、アトミックにキャッシュを READY 化するため。
   * @param mode - 動作モード ("online", "cold", "offline")。
   */
  public async initialize(mode: ModelCacheMode): Promise<void> {
    await this.storage.runExclusive(this.artifactSetHash, async () => {
      const readyPath = `sets/${this.artifactSetHash}/ready.json`;
      const readyExists = await this.storage.exists(readyPath);

      if (readyExists) {
        const allValid = await this.checkAllAssetsValid();
        if (allValid) {
          this.isReady = true;
          return;
        }
        if (mode === "offline" || mode === "cold") {
          throw new VectorError("E_ASSET_INTEGRITY");
        }
      } else {
        if (mode === "offline") {
          throw new VectorError("E_MODEL_CACHE_MISS");
        }
      }

      if (!this.fetcher) {
        throw new VectorError("E_MODEL_CACHE_MISS");
      }

      const stageStatePath = `sets/${this.artifactSetHash}/stage/state.json`;
      if (await this.storage.exists(stageStatePath)) {
        throw new VectorError("E_ASSET_INTEGRITY");
      }

      try {
        const stateWriter = await this.storage.createWriter(stageStatePath);
        await writeInChunks(
          stateWriter,
          new TextEncoder().encode(JSON.stringify({ status: "staging" })),
          this.chunkSize
        );
        await stateWriter.close();

        for (const asset of this.assets) {
          await this.fetchAndStageAsset(asset);
        }

        const readyWriter = await this.storage.createWriter(`sets/${this.artifactSetHash}/stage/ready.json`);
        await writeInChunks(
          readyWriter,
          new TextEncoder().encode(
            JSON.stringify({
              schemaVersion: 1,
              artifactSetHash: this.artifactSetHash,
              manifestHash: this.manifestHash
            })
          ),
          this.chunkSize
        );
        await readyWriter.close();

        if (await this.storage.exists(readyPath)) {
          await this.storage.removeTree(readyPath);
        }
        for (const asset of this.assets) {
          await this.storage.commit(
            `sets/${this.artifactSetHash}/stage/files/${asset.path}`,
            `sets/${this.artifactSetHash}/files/${asset.path}`
          );
        }
        await this.storage.commit(
          `sets/${this.artifactSetHash}/stage/ready.json`,
          readyPath
        );
        await this.storage.removeTree(`sets/${this.artifactSetHash}/stage`);
        this.isReady = true;
      } catch (err) {
        throw new VectorError("E_ASSET_INTEGRITY");
      }
    });
  }

  /**
   * 処理名: 明示的キャッシュ復旧
   * 処理概要: 中断されたステージング領域を排他的に削除し、未 READY 状態へ戻す。他リビジョンや DB は保持する。
   * 実装理由: 破損または中断されたダウンロード作業の安全な回復のため。
   */
  public async recover(): Promise<void> {
    await this.storage.runExclusive(this.artifactSetHash, async () => {
      await this.storage.removeTree(`sets/${this.artifactSetHash}/stage`);
      this.isReady = false;
    });
  }

  /**
   * 処理名: キャッシュファイル読み込み
   * 処理概要: READY 状態を確認後、公開資材ファイルを読み取って返す。
   * 実装理由: 未検証状態での推論モデル読み込みを防止するため。
   * @param path - マニフェスト論理パス。
   * @returns 資材バイナリ、または未知パスの場合 undefined。
   */
  public async read(path: string): Promise<Uint8Array | undefined> {
    if (path.includes("..") || !this.assetMap.has(path)) {
      return undefined;
    }
    if (!this.isReady) {
      throw new VectorError("E_MODEL_CACHE_MISS");
    }
    return this.storage.read(`sets/${this.artifactSetHash}/files/${path}`);
  }
}
