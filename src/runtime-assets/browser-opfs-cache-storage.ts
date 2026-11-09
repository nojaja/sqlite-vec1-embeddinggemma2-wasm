import { VectorError } from "../errors";
import { positiveOption, splitLogicalPath } from "./cache-path";
import type { ArtifactWriter, PersistentCacheStorage } from "./persistent-model-cache";

/**
 * 処理名: OPFSファイルスナップショットインターフェース
 * 処理概要: OPFS上の読み取りファイルスナップショットを表現する。
 * 実装理由: サイズ取得およびストリーム読み取りを可能にするため。
 */
export interface OpfsFileSnapshot {
  readonly size: number;
  /**
   * 処理名: ArrayBuffer取得
   * 処理概要: ファイル内容をArrayBufferとして取得する。
   * 実装理由: バイト列を一括取得するため。
   * @returns ファイル内容のArrayBufferプロミス。
   */
  arrayBuffer(): Promise<ArrayBuffer>;
  /**
   * 処理名: ReadableStream取得
   * 処理概要: ファイル内容のReadableStreamを取得する。
   * 実装理由: チャンク単位のストリーム読み込みを行うため。
   * @returns 読み取りストリーム。
   */
  stream(): ReadableStream<Uint8Array>;
}

/**
 * 処理名: OPFS書き込みインターフェース
 * 処理概要: OPFSへのチャンク書き込みと確定・中断を提供する。
 * 実装理由: アトミックかつ安全なファイル書き込みを実現するため。
 */
export interface OpfsWritable {
  /**
   * 処理名: データ書き込み
   * 処理概要: バイト配列を書き込む。
   * 実装理由: チャンクデータを順次書き出すため。
   * @param data 書き込み対象バイト配列。
   * @returns 完了プロミス。
   */
  write(data: Uint8Array<ArrayBuffer>): Promise<void>;
  /**
   * 処理名: 書き込み確定
   * 処理概要: ファイル書き込みを確定して閉じる。
   * 実装理由: ファイル内容をアトミックに確定するため。
   * @returns 完了プロミス。
   */
  close(): Promise<void>;
  /**
   * 処理名: 書き込み中断
   * 処理概要: 書き込み処理を中断して破棄する。
   * 実装理由: エラー時に中途半端なファイルを残さないため。
   * @returns 完了プロミス。
   */
  abort(): Promise<void>;
}

/**
 * 処理名: OPFSファイルハンドルインターフェース
 * 処理概要: OPFSファイルのエントリ操作を提供する。
 * 実装理由: スナップショット取得および書き込みストリーム取得を抽象化するため。
 */
export interface OpfsFileHandle {
  /**
   * 処理名: ファイルスナップショット取得
   * 処理概要: 現在のファイルスナップショットを取得する。
   * 実装理由: 読み取り処理を行うため。
   * @returns ファイルスナップショットのプロミス。
   */
  getFile(): Promise<OpfsFileSnapshot>;
  /**
   * 処理名: 書き込みストリーム生成
   * 処理概要: ファイル書き込みストリームを生成する。
   * 実装理由: ファイル書き出しを行うため。
   * @returns 書き込みストリームのプロミス。
   */
  createWritable(): Promise<OpfsWritable>;
}

/**
 * 処理名: OPFSエントリ取得オプションインターフェース
 * 処理概要: ディレクトリやファイルハンドル取得時の作成指定を保持する。
 * 実装理由: 存在しない場合の作成有無を制御するため。
 */
export interface OpfsGetEntryOptions {
  create?: boolean;
}

/**
 * 処理名: OPFSエントリ削除オプションインターフェース
 * 処理概要: エントリ削除時の再帰指定を保持する。
 * 実装理由: 再帰的ディレクトリ削除を制御するため。
 */
export interface OpfsRemoveEntryOptions {
  recursive?: boolean;
}

/**
 * 処理名: OPFSディレクトリハンドルインターフェース
 * 処理概要: OPFSディレクトリ走査・エントリ取得・削除を提供する。
 * 実装理由: ディレクトリ階層の走査とエントリ管理を抽象化するため。
 */
export interface OpfsDirectoryHandle {
  /**
   * 処理名: サブディレクトリハンドル取得
   * 処理概要: 指定名のサブディレクトリハンドルを取得する。
   * 実装理由: 階層的なディレクトリパスを解決するため。
   * @param name ディレクトリ名。
   * @param options 取得オプション。
   * @returns ディレクトリハンドルのプロミス。
   */
  getDirectoryHandle(name: string, options?: OpfsGetEntryOptions): Promise<OpfsDirectoryHandle>;
  /**
   * 処理名: ファイルハンドル取得
   * 処理概要: 指定名のファイルハンドルを取得する。
   * 実装理由: ファイルへのアクセスを可能にするため。
   * @param name ファイル名。
   * @param options 取得オプション。
   * @returns ファイルハンドルのプロミス。
   */
  getFileHandle(name: string, options?: OpfsGetEntryOptions): Promise<OpfsFileHandle>;
  /**
   * 処理名: エントリ削除
   * 処理概要: 指定名のエントリを削除する。
   * 実装理由: キャッシュファイルやディレクトリのクリーンアップを行うため。
   * @param name エントリ名。
   * @param options 削除オプション。
   * @returns 完了プロミス。
   */
  removeEntry(name: string, options?: OpfsRemoveEntryOptions): Promise<void>;
}

/**
 * 処理名: ブラウザロックマネージャーインターフェース
 * 処理概要: Web Locks APIの排他実行制御を提供する。
 * 実装理由: 複数タブ間でのキャッシュ操作競合を防止するため。
 */
export interface BrowserLockManager {
  /**
   * 処理名: 排他ロック要求
   * 処理概要: 指定名のロックを取得してアクションを実行する。
   * 実装理由: 排他的に非同期処理を実行するため。
   * @param name ロック名。
   * @param action 実行アクション関数。
   * @returns アクションの実行結果プロミス。
   */
  request<Result>(name: string, action: () => Promise<Result>): Promise<Result>;
}

/**
 * 処理名: ブラウザOPFSオプションインターフェース
 * 処理概要: OPFS永続キャッシュストレージの設定オプションを定義する。
 * 実装理由: 最大書き込みバイト数等のパラメータを柔軟に設定するため。
 */
export interface BrowserOpfsOptions {
  maxWriteBytes?: number;
}

/**
 * 処理名: NotFound判定
 * 処理概要: OPFSのNotFoundErrorだけを不存在として判定する。
 * 実装理由: 他のI/O errorを不存在に偽装しないため。
 * @param error - 例外。
 * @returns NotFoundErrorならtrue。
 */
function isNotFound(error: unknown): boolean { return (error as { name?: string } | null)?.name === "NotFoundError"; }

/**
 * 処理名: SHA-256 hex
 * 処理概要: Web Cryptoで1ファイル分のdigestを計算する。
 * 実装理由: node:cryptoをbrowser bundleへ含めないため。
 * @param bytes - 対象bytes。
 * @returns 小文字hex。
 */
async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");
}

/**
 * 処理名: OPFSアーティファクトライター
 * 処理概要: チャンク単位の書き込みとアトミック確定を制御するライタークラス。
 * 実装理由: 一定サイズごとの書き出しと書き込み整合性を保証するため。
 */
class OpfsArtifactWriter implements ArtifactWriter {
  private closed = false;

  /**
   * 処理名: writer生成
   * 処理概要: writableと上限を保持する。
   * 実装理由: close時のatomic公開に依存するため。
   * @param writable - OPFS writable。
   * @param limit - 1回の書込み上限。
   */
  public constructor(private readonly writable: OpfsWritable, private readonly limit: number) {}

  /**
   * 処理名: chunk書込み
   * 処理概要: 上限内のchunkをcopyして書く。
   * 実装理由: callerのbufferと分離するため。
   * @param chunk - 書込みbytes。
   */
  public async write(chunk: Uint8Array): Promise<void> {
    if (this.closed || chunk.byteLength > this.limit) throw new VectorError("E_ASSET_INTEGRITY");
    await this.writable.write(chunk.slice());
  }

  /**
   * 処理名: 確定
   * 処理概要: closeして公開する。二重closeは拒否する。
   * 実装理由: atomic closeで部分fileを公開しないため。
   */
  public async close(): Promise<void> {
    if (this.closed) throw new VectorError("E_ASSET_INTEGRITY");
    this.closed = true;
    await this.writable.close();
  }

  /**
   * 処理名: 中止
   * 処理概要: 未確定writableを破棄する。
   * 実装理由: 失敗後の再利用を防ぐため。
   */
  public async abort(): Promise<void> {
    if (!this.closed) { this.closed = true; await this.writable.abort(); }
  }
}

/**
 * 処理名: browser OPFS保存adapter
 * 処理概要: OPFS handleをsegmentで辿りWeb Locksで排他する。
 * 実装理由: browser永続cacheをNodeと同じ契約で提供するため。
 */
export class BrowserOpfsPersistentCacheStorage implements PersistentCacheStorage {
  private readonly maxWriteBytes: number;

  /**
   * 処理名: adapter生成
   * 処理概要: root handle、lock、optionを保持する。
   * 実装理由: mockを差し替え可能にするため。
   * @param root - cache root handle。
   * @param locks - Web Locks。
   * @param options - option。
   */
  public constructor(private readonly root: OpfsDirectoryHandle, private readonly locks: BrowserLockManager, options: BrowserOpfsOptions = {}) {
    this.maxWriteBytes = positiveOption(options.maxWriteBytes, 1024 * 1024);
  }

  /**
   * 処理名: 親directory取得
   * 処理概要: 最後のsegment以外を辿る。
   * 実装理由: 論理path境界を保つため。
   * @param segments - 検証済みsegment。
   * @param create - 作成するか。
   * @returns 親handle。不存在はundefined。
   */
  private async parent(segments: readonly string[], create: boolean): Promise<OpfsDirectoryHandle | undefined> {
    let directory = this.root;
    try {
      for (const segment of segments.slice(0, -1)) directory = await directory.getDirectoryHandle(segment, { create });
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
    return directory;
  }

  /**
   * 処理名: snapshot取得
   * 処理概要: fileのsnapshotを返す。不存在はundefined。
   * 実装理由: 不存在だけをNotFoundErrorで判定するため。
   * @param path - 論理path。
   * @returns snapshot。
   */
  private async snapshot(path: string): Promise<OpfsFileSnapshot | undefined> {
    const segments = splitLogicalPath(path);
    const directory = await this.parent(segments, false);
    if (directory === undefined) return undefined;
    try {
      return await (await directory.getFileHandle(segments[segments.length - 1] as string)).getFile();
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  /**
   * 処理名: 存在確認
   * 処理概要: fileが存在するかを返す。
   * 実装理由: stage残存判定のため。
   * @param path - 論理path。
   * @returns 存在時true。
   */
  public async exists(path: string): Promise<boolean> { return (await this.snapshot(path)) !== undefined; }

  /**
   * 処理名: 読込み
   * 処理概要: fileのbytesを返す。
   * 実装理由: 呼出し側で再検証するため。
   * @param path - 論理path。
   * @returns bytes。
   */
  public async read(path: string): Promise<Uint8Array | undefined> {
    const snapshot = await this.snapshot(path);
    return snapshot === undefined ? undefined : new Uint8Array(await snapshot.arrayBuffer());
  }

  /**
   * 処理名: digest計算
   * 処理概要: 1ファイルずつWeb Cryptoで計算する。
   * 実装理由: 巨大fileを同時にmaterializeしないため。
   * @param path - 論理path。
   * @returns 完全性情報。
   */
  public async digest(path: string): Promise<{ bytes: number; sha256: string } | undefined> {
    const snapshot = await this.snapshot(path);
    if (snapshot === undefined) return undefined;
    const buffer = await snapshot.arrayBuffer();
    return { bytes: buffer.byteLength, sha256: await sha256Hex(buffer) };
  }

  /**
   * 処理名: writer作成
   * 処理概要: atomic closeのwritableを返す。
   * 実装理由: 部分fileを公開しないため。
   * @param path - 論理path。
   * @returns writer。
   */
  public async createWriter(path: string): Promise<ArtifactWriter> {
    const segments = splitLogicalPath(path);
    const directory = await this.parent(segments, true) as OpfsDirectoryHandle;
    const handle = await directory.getFileHandle(segments[segments.length - 1] as string, { create: true });
    return new OpfsArtifactWriter(await handle.createWritable(), this.maxWriteBytes);
  }

  /**
   * 処理名: commit
   * 処理概要: sourceをbounded copyしてtargetを確定しsourceを削除する。
   * 実装理由: 非標準moveに依存しないため。
   * @param source - stage path。
   * @param target - 公開path。
   */
  public async commit(source: string, target: string): Promise<void> {
    const snapshot = await this.snapshot(source);
    if (snapshot === undefined) throw new VectorError("E_ASSET_INTEGRITY");
    const writer = await this.createWriter(target);
    try {
      const reader = snapshot.stream().getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (let offset = 0; offset < value.byteLength; offset += this.maxWriteBytes) await writer.write(value.subarray(offset, offset + this.maxWriteBytes));
      }
      await writer.close();
    } catch (error) {
      await writer.abort().catch(() => undefined);
      throw error;
    }
    await this.removeEntry(source, false);
  }

  /**
   * 処理名: entry削除
   * 処理概要: 最後のsegmentを削除する。不存在は無視する。
   * 実装理由: stage/files削除を共通化するため。
   * @param path - 論理path。
   * @param recursive - 再帰削除。
   */
  private async removeEntry(path: string, recursive: boolean): Promise<void> {
    const segments = splitLogicalPath(path);
    const directory = await this.parent(segments, false);
    if (directory === undefined) return;
    try { await directory.removeEntry(segments[segments.length - 1] as string, { recursive }); } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  /**
   * 処理名: tree削除
   * 処理概要: 指定prefixを再帰削除する。
   * 実装理由: stage recoveryのため。
   * @param prefix - 削除対象。
   */
  public async removeTree(prefix: string): Promise<void> { await this.removeEntry(prefix, true); }

  /**
   * 処理名: 排他実行
   * 処理概要: Web Locksでset単位に排他する。
   * 実装理由: 複数tab間のstage競合を防ぐため。
   * @param key - lock key。
   * @param action - 実行処理。
   * @returns 処理結果。
   */
  public runExclusive<T>(key: string, action: () => Promise<T>): Promise<T> { return this.locks.request(`svw-model-cache:${key}`, action); }
}

/**
 * 処理名: browser保存adapter作成
 * 処理概要: OPFS root直下の.svw-modelsとnavigator.locksで生成する。
 * 実装理由: 業務DBのpool領域と分離するため。
 * @param options - option。
 * @returns adapter。
 */
export async function createBrowserOpfsPersistentCacheStorage(options?: BrowserOpfsOptions): Promise<BrowserOpfsPersistentCacheStorage> {
  const root = await navigator.storage.getDirectory() as unknown as OpfsDirectoryHandle;
  return new BrowserOpfsPersistentCacheStorage(await root.getDirectoryHandle(".svw-models", { create: true }), navigator.locks as unknown as BrowserLockManager, options);
}
