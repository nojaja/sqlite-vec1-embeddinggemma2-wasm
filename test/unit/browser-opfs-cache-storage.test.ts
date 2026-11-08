import {
  BrowserOpfsPersistentCacheStorage,
  type BrowserLockManager,
  type OpfsDirectoryHandle,
  type OpfsFileHandle,
  type OpfsFileSnapshot,
  type OpfsWritable
} from "../../src/runtime-assets/browser-opfs-cache-storage";

/**
 * 処理名: memory OPFS writable
 * 処理概要: close時だけfile mapへbytesを公開する。
 * 実装理由: OPFS createWritableのatomic close契約をunit testで再現するため。
 */
class MemoryWritable implements OpfsWritable {
  private readonly chunks: Uint8Array[] = [];

  /**
   * 処理名: writable初期化
   * 処理概要: file mapと公開pathを保持する。
   * 実装理由: closeまで既存値を変更しないため。
   * @param files - file map。
   * @param path - 公開path。
   */
  constructor(private readonly files: Map<string, Uint8Array>, private readonly path: string) {}

  /** 処理名: OPFS mock書込み 処理概要: chunk copyを蓄積する。 実装理由: caller変更を分離するため。
   * @param data - 書込みbytes。
   * @returns 書込み完了。
   */
  async write(data: Uint8Array): Promise<void> { this.chunks.push(data.slice()); }

  /** 処理名: OPFS mock確定 処理概要: close時に結合bytesを公開する。 実装理由: atomic publicationを再現するため。
   * @returns close完了。
   */
  async close(): Promise<void> {
    let size = 0;
    for (const chunk of this.chunks) size += chunk.length;
    const output = new Uint8Array(size);
    let offset = 0;
    for (const chunk of this.chunks) { output.set(chunk, offset); offset += chunk.length; }
    this.files.set(this.path, output);
  }

  /** 処理名: OPFS mock中止 処理概要: chunkを破棄する。 実装理由: abort時に未確定値を公開しないため。
   * @returns abort完了。
   */
  async abort(): Promise<void> { this.chunks.length = 0; }
}

/**
 * 処理名: memory OPFS file
 * 処理概要: file snapshotとwritableを共通map上で提供する。
 * 実装理由: browser APIなしでadapterを検証するため。
 */
class MemoryFileHandle implements OpfsFileHandle {
  /**
   * 処理名: file handle初期化
   * 処理概要: mapとpathを保持する。
   * 実装理由: file単位操作を再現するため。
   * @param files - file map。
   * @param path - file path。
   */
  constructor(private readonly files: Map<string, Uint8Array>, private readonly path: string) {}

  /** 処理名: snapshot取得 処理概要: 現在のfile bytesを返す。 実装理由: read/digestを再現するため。
   * @returns file snapshot。
   */
  async getFile(): Promise<OpfsFileSnapshot> {
    const value = this.files.get(this.path) ?? new Uint8Array();
    return {
      size: value.length,
      /** 処理名: memory snapshot bytes 処理概要: copyのArrayBufferを返す。 実装理由: digest入力を分離するため。
       * @returns snapshot bytes。
       */
      arrayBuffer: async (): Promise<ArrayBuffer> => Uint8Array.from(value).buffer,
      /** 処理名: memory snapshot stream 処理概要: copyのstreamを返す。 実装理由: commit copyを再現するため。
       * @returns snapshot stream。
       */
      stream: (): ReadableStream<Uint8Array> => new Blob([Uint8Array.from(value)]).stream()
    };
  }

  /** 処理名: writable取得 処理概要: atomic close型writerを返す。 実装理由: OPFS保存を再現するため。
   * @returns writable。
   */
  async createWritable(): Promise<OpfsWritable> { return new MemoryWritable(this.files, this.path); }
}

/**
 * 処理名: memory OPFS directory
 * 処理概要: directory/file handleと再帰削除をpath map上で提供する。
 * 実装理由: navigator.storageなしでOPFS behaviorを検証するため。
 */
class MemoryDirectoryHandle implements OpfsDirectoryHandle {
  readonly files = new Map<string, Uint8Array>();

  /**
   * 処理名: directory初期化
   * 処理概要: shared mapとdirectory prefixを保持する。
   * 実装理由: nested handleを同じtreeへ接続するため。
   * @param prefix - directory prefix。
   * @param shared - 共有file map。
   */
  constructor(private readonly prefix = "", shared?: Map<string, Uint8Array>) {
    if (shared !== undefined) this.files = shared;
  }

  /** 処理名: child directory取得 処理概要: 同じmapのchild handleを返す。 実装理由: path traversalを再現するため。
   * @param name - child名。
   * @returns directory handle。
   */
  async getDirectoryHandle(name: string): Promise<OpfsDirectoryHandle> { return new MemoryDirectoryHandle(`${this.prefix}${name}/`, this.files); }

  /** 処理名: child file取得 処理概要: 同じmapのfile handleを返す。 実装理由: file操作を再現するため。
   * @param name - file名。
   * @param options - create指定。
   * @param options.create - file作成指定。
   * @returns file handle。
   */
  async getFileHandle(name: string, options?: { create?: boolean }): Promise<OpfsFileHandle> {
    const path = `${this.prefix}${name}`;
    if (options?.create !== true && !this.files.has(path)) throw new DOMException("missing", "NotFoundError");
    return new MemoryFileHandle(this.files, path);
  }

  /** 処理名: child削除 処理概要: fileまたはdirectory prefixを削除する。 実装理由: stage recoveryを再現するため。
   * @param name - child名。
   * @param _options - 再帰指定。
   * @param _options.recursive - tree削除指定。
   * @returns 削除完了。
   */
  async removeEntry(name: string, _options?: { recursive?: boolean }): Promise<void> {
    const path = `${this.prefix}${name}`;
    this.files.delete(path);
    for (const key of this.files.keys()) if (key.startsWith(`${path}/`)) this.files.delete(key);
  }
}

/**
 * 処理名: recording Web Locks
 * 処理概要: request名を記録してcallbackを実行する。
 * 実装理由: set固有lock利用を確認するため。
 */
class RecordingLocks implements BrowserLockManager {
  readonly names: string[] = [];

  /** 処理名: lock request 処理概要: lock名を記録し処理を実行する。 実装理由: Web Locks連携を観測するため。
   * @param name - lock名。
   * @param action - 排他処理。
   * @returns 処理結果。
   */
  async request<T>(name: string, action: () => Promise<T>): Promise<T> { this.names.push(name); return action(); }
}

/**
 * 処理名: browser OPFS lifecycle検証
 * 処理概要: atomic close、bounded write、digest、commit、削除を確認する。
 * 実装理由: browser adapterの永続cache契約を保証するため。
 */
async function verifyBrowserStorageLifecycle(): Promise<void> {
  const root = new MemoryDirectoryHandle();
  const locks = new RecordingLocks();
  const storage = new BrowserOpfsPersistentCacheStorage(root, locks, { maxWriteBytes: 4 });
  const writer = await storage.createWriter("sets/a/stage/file.bin");
  await writer.write(new Uint8Array([1, 2, 3, 4]));
  expect(await storage.exists("sets/a/stage/file.bin")).toBe(false);
  await expect(writer.write(new Uint8Array(5))).rejects.toThrow("E_ASSET_INTEGRITY");
  await writer.close();
  expect(await storage.digest("sets/a/stage/file.bin")).toEqual({ bytes: 4, sha256: "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a" });
  await storage.commit("sets/a/stage/file.bin", "sets/a/files/file.bin");
  expect(await storage.read("sets/a/files/file.bin")).toEqual(new Uint8Array([1, 2, 3, 4]));
  await storage.removeTree("sets/a/files");
  expect(await storage.exists("sets/a/files/file.bin")).toBe(false);
  await storage.runExclusive("a".repeat(64), async (): Promise<void> => undefined);
  expect(locks.names).toEqual([`svw-model-cache:${"a".repeat(64)}`]);
}

/**
 * 処理名: browser path拒否検証
 * 処理概要: traversal、空segment、backslashをOPFS操作前に拒否する。
 * 実装理由: cache root外のhandle解決を防ぐため。
 */
async function verifyBrowserPathProtection(): Promise<void> {
  const storage = new BrowserOpfsPersistentCacheStorage(new MemoryDirectoryHandle(), new RecordingLocks());
  await expect(storage.read("../secret")).rejects.toThrow("E_ASSET_INTEGRITY");
  await expect(storage.read("sets//file")).rejects.toThrow("E_ASSET_INTEGRITY");
  await expect(storage.read("sets\\file")).rejects.toThrow("E_ASSET_INTEGRITY");
}

test("G05 browser adapter: OPFS lifecycle and Web Locks", verifyBrowserStorageLifecycle);
test("G05 browser adapter: strict logical path protection", verifyBrowserPathProtection);
