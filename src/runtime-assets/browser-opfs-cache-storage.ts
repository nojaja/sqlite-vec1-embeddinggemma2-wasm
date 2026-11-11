import { VectorError } from "../errors";
import {
  ArtifactWriter,
  PersistentCacheStorage
} from "./persistent-model-cache";

/**
 * 処理名: SHA-256 16進文字列計算
 * 処理概要: Web Crypto API を用いて入力 ArrayBuffer の SHA-256 ダイジェストを計算する。
 * 実装理由: ブラウザ環境で外部依存なしに完全性検証を行うため。
 * @param data - 入力バッファ。
 * @returns 64文字の小文字16進ハッシュ。
 */
async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * 処理名: ブラウザ Web Locks マネージャーインターフェース
 * 処理概要: 排他ロック取得とコールバック実行を抽象化する。
 * 実装理由: navigator.locks のモックおよび実ブラウザ双方に対応するため。
 */
export interface BrowserLockManager {
  request<Result>(name: string, action: () => Promise<Result>): Promise<Result>;
}

/**
 * 処理名: OPFS ファイルスナップショットインターフェース
 * 処理概要: ファイルサイズ、ArrayBuffer 取得、ストリーム取得を提供する。
 * 実装理由: FileSystemFileHandle.getFile() の戻り値規約に準拠するため。
 */
export interface OpfsFileSnapshot {
  readonly size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
  stream(): ReadableStream<Uint8Array>;
}

/**
 * 処理名: OPFS 書き込みストリームインターフェース
 * 処理概要: チャンク書き込み、コミット（close）、アボートを提供する。
 * 実装理由: FileSystemWritableFileStream の atomic 動作を抽象化するため。
 */
export interface OpfsWritable {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

/**
 * 処理名: OPFS ファイルハンドルインターフェース
 * 処理概要: スナップショット取得および書き込みストリーム生成を提供する。
 * 実装理由: FileSystemFileHandle 互換操作のため。
 */
export interface OpfsFileHandle {
  getFile(): Promise<OpfsFileSnapshot>;
  createWritable(): Promise<OpfsWritable>;
}

/**
 * 処理名: OPFS ディレクトリハンドルインターフェース
 * 処理概要: 子ディレクトリ・ファイルの取得およびエントリ削除を提供する。
 * 実装理由: FileSystemDirectoryHandle 互換操作のため。
 */
export interface OpfsDirectoryHandle {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<OpfsDirectoryHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<OpfsFileHandle>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
}

/**
 * 処理名: ブラウザ OPFS ストレージオプション
 * 処理概要: 最大書き込みバイト数を指定する型。
 */
export interface BrowserStorageOptions {
  maxWriteBytes?: number;
}

/**
 * 処理名: BrowserOpfsPersistentCacheStorage クラス
 * 処理概要: ブラウザの Origin Private File System (OPFS) 上でモデルキャッシュストレージを提供する。
 * 実装理由: Web Locks による排他制御と OPFS の安全な階層操作を統合するため。
 */
export class BrowserOpfsPersistentCacheStorage implements PersistentCacheStorage {
  private readonly root: OpfsDirectoryHandle;
  private readonly locks: BrowserLockManager;
  private readonly maxWriteBytes: number;

  /**
   * 処理名: BrowserOpfsPersistentCacheStorage コンストラクタ
   * 処理概要: ルートディレクトリハンドル、Web Locks マネージャー、最大書き込み容量を初期化する。
   * 実装理由: ブラウザ環境下でのモデルキャッシュ I/O 基盤を構築するため。
   * @param root - OPFS ルートディレクトリハンドル。
   * @param locks - Web Locks マネージャー。
   * @param options - ストレージオプション。
   */
  constructor(
    root: OpfsDirectoryHandle,
    locks: BrowserLockManager,
    options?: BrowserStorageOptions
  ) {
    this.root = root;
    this.locks = locks;
    this.maxWriteBytes = options?.maxWriteBytes ?? 1024 * 1024;
  }

  /**
   * 処理名: 論理パスセグメント検証
   * 処理概要: 論理パスを検証してセグメント配列へ分解する。traversal や空文字は拒絶する。
   * 実装理由: OPFS ルート外へのエスケープや不正なファイル名を防ぐため。
   * @param logicalPath - 論理パス。
   * @returns 有効なパスセグメント配列。
   */
  private parseSegments(logicalPath: string): string[] {
    if (typeof logicalPath !== "string" || logicalPath.trim().length === 0) {
      throw new VectorError("E_ASSET_INTEGRITY");
    }
    if (logicalPath.includes("\\")) {
      throw new VectorError("E_ASSET_INTEGRITY");
    }
    const segments = logicalPath.split("/");
    for (const seg of segments) {
      if (seg === "" || seg === "." || seg === ".." || !/^[A-Za-z0-9._-]+$/.test(seg)) {
        throw new VectorError("E_ASSET_INTEGRITY");
      }
    }
    return segments;
  }

  /**
   * 処理名: 親ディレクトリおよびファイル名解決
   * 処理概要: セグメントを辿って親ディレクトリハンドルと最終ファイル名を取得する。
   * 実装理由: 階層的な OPFS ハンドル操作を共通化するため。
   * @param segments - パスセグメント配列。
   * @param create - ディレクトリが存在しない場合に自動生成するかどうか。
   * @returns 親ディレクトリハンドルとファイル名。
   */
  private async resolveParentAndName(
    segments: string[],
    create: boolean
  ): Promise<{ dir: OpfsDirectoryHandle; name: string }> {
    let cur = this.root;
    for (let i = 0; i < segments.length - 1; i++) {
      cur = await cur.getDirectoryHandle(segments[i]!, { create });
    }
    return { dir: cur, name: segments[segments.length - 1]! };
  }

  /**
   * 処理名: ファイル存在確認
   * 処理概要: 指定論理パスのファイルが存在するか判定する。
   * 実装理由: ステージングおよび公開ファイルの有無を調べるため。
   * @param logicalPath - 論理パス。
   * @returns 存在時 true、不存在時 false。
   */
  public async exists(logicalPath: string): Promise<boolean> {
    try {
      const segments = this.parseSegments(logicalPath);
      const { dir, name } = await this.resolveParentAndName(segments, false);
      await dir.getFileHandle(name);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 処理名: ファイル読み出し
   * 処理概要: ファイルから全バイトを読み取り Uint8Array で返す。
   * 実装理由: キャッシュ資材の読み込みのため。
   * @param logicalPath - 論理パス。
   * @returns 読み取られたバイト配列、または不存在時 undefined。
   */
  public async read(logicalPath: string): Promise<Uint8Array | undefined> {
    const segments = this.parseSegments(logicalPath);
    try {
      const { dir, name } = await this.resolveParentAndName(segments, false);
      const fileHandle = await dir.getFileHandle(name);
      const snapshot = await fileHandle.getFile();
      const ab = await snapshot.arrayBuffer();
      return new Uint8Array(ab);
    } catch (err: unknown) {
      if ((err as { name?: string })?.name === "NotFoundError") {
        return undefined;
      }
      return undefined;
    }
  }

  /**
   * 処理名: ファイルダイジェスト計算
   * 処理概要: ファイルのサイズおよび SHA-256 ダイジェストを計算して返す。
   * 実装理由: 資材の完全性を照合するため。
   * @param logicalPath - 論理パス。
   * @returns 完全性情報、または不存在時 undefined。
   */
  public async digest(logicalPath: string): Promise<{ bytes: number; sha256: string } | undefined> {
    const segments = this.parseSegments(logicalPath);
    try {
      const { dir, name } = await this.resolveParentAndName(segments, false);
      const fileHandle = await dir.getFileHandle(name);
      const snapshot = await fileHandle.getFile();
      const ab = await snapshot.arrayBuffer();
      const sha = await sha256Hex(ab);
      return { bytes: snapshot.size, sha256: sha };
    } catch {
      return undefined;
    }
  }

  /**
   * 処理名: ライター生成
   * 処理概要: OPFS ファイルへのチャンク書き込みライターを作成する。
   * 実装理由: 容量制限チェックとアトミックコミットを支援するため。
   * @param logicalPath - 出力先論理パス。
   * @returns ArtifactWriter インスタンス。
   */
  public async createWriter(logicalPath: string): Promise<ArtifactWriter> {
    const segments = this.parseSegments(logicalPath);
    const { dir, name } = await this.resolveParentAndName(segments, true);
    const fileHandle = await dir.getFileHandle(name, { create: true });
    const writable = await fileHandle.createWritable();
    const maxBytes = this.maxWriteBytes;

    return {
      write: async (chunk: Uint8Array): Promise<void> => {
        if (chunk.byteLength > maxBytes) {
          throw new VectorError("E_ASSET_INTEGRITY");
        }
        await writable.write(chunk);
      },
      close: async (): Promise<void> => {
        await writable.close();
      },
      abort: async (): Promise<void> => {
        await writable.abort();
      }
    };
  }

  /**
   * 処理名: アトミックコミット
   * 処理概要: ソースファイルを読み取り、ターゲットへチャンク書き込みしてソースを削除する。
   * 実装理由: OPFS において標準 rename が未提供な環境でも安全にファイルを移動するため。
   * @param sourcePath - 移動元論理パス。
   * @param targetPath - 移動先論理パス。
   */
  public async commit(sourcePath: string, targetPath: string): Promise<void> {
    const srcSegments = this.parseSegments(sourcePath);
    const dstSegments = this.parseSegments(targetPath);

    const { dir: srcDir, name: srcName } = await this.resolveParentAndName(srcSegments, false);
    const srcFile = await srcDir.getFileHandle(srcName);
    const snapshot = await srcFile.getFile();
    const data = new Uint8Array(await snapshot.arrayBuffer());

    const { dir: dstDir, name: dstName } = await this.resolveParentAndName(dstSegments, true);
    const dstFile = await dstDir.getFileHandle(dstName, { create: true });
    const writable = await dstFile.createWritable();

    let offset = 0;
    while (offset < data.length) {
      const sliceLen = Math.min(this.maxWriteBytes, data.length - offset);
      await writable.write(data.subarray(offset, offset + sliceLen));
      offset += sliceLen;
    }
    await writable.close();

    await srcDir.removeEntry(srcName);
  }

  /**
   * 処理名: ツリー削除
   * 処理概要: 指定論理パスのエントリを再帰的に削除する。
   * 実装理由: ステージング領域などの一括クリーンアップのため。
   * @param prefix - 削除対象プレフィックス。
   */
  public async removeTree(prefix: string): Promise<void> {
    const segments = this.parseSegments(prefix);
    try {
      const { dir, name } = await this.resolveParentAndName(segments, false);
      await dir.removeEntry(name, { recursive: true });
    } catch {
      // 存在しない場合は正常終了
    }
  }

  /**
   * 処理名: Web Locks 排他実行
   * 処理概要: svw-model-cache プレフィックスを付けた Web Lock を取得して処理を実行する。
   * 実装理由: ブラウザタブ間およびワーカー間でのアーティファクトセット並行ダウンロード排他を行うため。
   * @param key - 排他キー。
   * @param action - 実行処理関数。
   * @returns 処理結果の Promise。
   */
  public async runExclusive<T>(key: string, action: () => Promise<T>): Promise<T> {
    const lockName = `svw-model-cache:${key}`;
    return this.locks.request(lockName, action);
  }
}

/**
 * 処理名: ブラウザ OPFS ストレージ生成ファクトリ
 * 処理概要: グローバル navigator.storage および navigator.locks からストレージを生成する。
 * 実装理由: ブラウザ環境向けのエントリポイントを提供するため。
 * @param options - ストレージオプション。
 * @returns PersistentCacheStorage インスタンス。
 */
export async function createBrowserOpfsPersistentCacheStorage(
  options?: BrowserStorageOptions
): Promise<PersistentCacheStorage> {
  const root = (await (navigator.storage as { getDirectory(): Promise<OpfsDirectoryHandle> }).getDirectory());
  const locks = (navigator as unknown as { locks: BrowserLockManager }).locks;
  return new BrowserOpfsPersistentCacheStorage(root, locks, options);
}
