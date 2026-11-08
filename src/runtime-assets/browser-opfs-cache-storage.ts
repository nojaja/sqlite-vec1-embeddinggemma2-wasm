import { VectorError } from "../errors";
import { positiveOption, splitLogicalPath } from "./cache-path";
import type { ArtifactWriter, PersistentCacheStorage } from "./persistent-model-cache";

/** OPFS file snapshot。 */
export interface OpfsFileSnapshot { readonly size: number; arrayBuffer(): Promise<ArrayBuffer>; stream(): ReadableStream<Uint8Array> }
/** OPFS writable。 */
export interface OpfsWritable { write(data: Uint8Array<ArrayBuffer>): Promise<void>; close(): Promise<void>; abort(): Promise<void> }
/** OPFS file handle。 */
export interface OpfsFileHandle { getFile(): Promise<OpfsFileSnapshot>; createWritable(): Promise<OpfsWritable> }
/** OPFS directory handle。 */
export interface OpfsDirectoryHandle {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<OpfsDirectoryHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<OpfsFileHandle>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
}
/** Web Locks境界。 */
export interface BrowserLockManager { request<Result>(name: string, action: () => Promise<Result>): Promise<Result> }
/** browser保存adapterのoption。 */
export interface BrowserOpfsOptions { maxWriteBytes?: number }

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

/** OPFS writer。 */
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
