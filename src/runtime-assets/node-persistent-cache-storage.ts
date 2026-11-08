import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, rm, rmdir, type FileHandle } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { VectorError } from "../errors";
import { positiveOption, splitLogicalPath } from "./cache-path";
import type { ArtifactWriter, PersistentCacheStorage } from "./persistent-model-cache";

/** Node保存adapterのoption。 */
export interface NodePersistentCacheOptions { maxWriteBytes?: number; lockRetryMs?: number; lockTimeoutMs?: number }

/**
 * 処理名: errno取得
 * 処理概要: 例外からerror codeを取り出す。
 * 実装理由: ENOENT/EEXISTだけを区別するため。
 * @param error - 例外。
 * @returns error code。
 */
function errorCode(error: unknown): string | undefined { return (error as { code?: string } | null)?.code; }

/** Node file writer。 */
class NodeArtifactWriter implements ArtifactWriter {
  private closed = false;

  /**
   * 処理名: writer生成
   * 処理概要: 開いたhandleとpathを保持する。
   * 実装理由: abort時に所有fileだけ削除するため。
   * @param handle - file handle。
   * @param path - 実path。
   * @param limit - 1回の書込み上限。
   */
  public constructor(private readonly handle: FileHandle, private readonly path: string, private readonly limit: number) {}

  /**
   * 処理名: chunk書込み
   * 処理概要: 上限内のchunkを全byte書き込む。
   * 実装理由: partial writeを完了させるため。
   * @param chunk - 書込みbytes。
   */
  public async write(chunk: Uint8Array): Promise<void> {
    if (this.closed || chunk.byteLength > this.limit) throw new VectorError("E_ASSET_INTEGRITY");
    let offset = 0;
    while (offset < chunk.byteLength) {
      const { bytesWritten } = await this.handle.write(chunk, offset, chunk.byteLength - offset);
      if (bytesWritten <= 0) throw new VectorError("E_ASSET_INTEGRITY");
      offset += bytesWritten;
    }
  }

  /**
   * 処理名: 確定
   * 処理概要: fsync後にcloseする。二重closeは拒否する。
   * 実装理由: 永続化後にcommitさせるため。
   */
  public async close(): Promise<void> {
    if (this.closed) throw new VectorError("E_ASSET_INTEGRITY");
    this.closed = true;
    await this.handle.sync();
    await this.handle.close();
  }

  /**
   * 処理名: 中止
   * 処理概要: 所有fileを閉じて削除する。
   * 実装理由: 未確定fileを残さないため。
   */
  public async abort(): Promise<void> {
    if (!this.closed) { this.closed = true; await this.handle.close().catch(() => undefined); }
    await rm(this.path, { force: true });
  }
}

/**
 * 処理名: Node永続cache保存adapter
 * 処理概要: canonical root配下でsymlinkを拒否しつつ保存・排他を行う。
 * 実装理由: cacheDirectory外のmodelやDBを読み書きさせないため。
 */
export class NodePersistentCacheStorage implements PersistentCacheStorage {
  private readonly maxWriteBytes: number;
  private readonly lockRetryMs: number;
  private readonly lockTimeoutMs: number;

  /**
   * 処理名: adapter生成
   * 処理概要: canonical rootとoptionを保持する。
   * 実装理由: 各操作でroot差替えを検出するため。
   * @param root - canonical root。
   * @param options - option。
   */
  private constructor(private readonly root: string, options: NodePersistentCacheOptions) {
    this.maxWriteBytes = positiveOption(options.maxWriteBytes, 1024 * 1024);
    this.lockRetryMs = positiveOption(options.lockRetryMs, 25);
    this.lockTimeoutMs = positiveOption(options.lockTimeoutMs, 30000);
  }

  /**
   * 処理名: adapter作成
   * 処理概要: rootを作成しcanonical pathを確定する。
   * 実装理由: 以後のpath境界確認の基準にするため。
   * @param directory - cache root。
   * @param options - option。
   * @returns adapter。
   */
  public static async create(directory: string, options: NodePersistentCacheOptions = {}): Promise<NodePersistentCacheStorage> {
    await mkdir(directory, { recursive: true });
    return new NodePersistentCacheStorage(await realpath(resolve(directory)), options);
  }

  /**
   * 処理名: path解決
   * 処理概要: 論理pathを検証し祖先のsymlink/非directoryを拒否して実pathを返す。
   * 実装理由: root差替えとlink経由の領域外参照を防ぐため。
   * @param path - 論理path。
   * @returns 実path。
   */
  private async resolveSafe(path: string): Promise<string> {
    const segments = splitLogicalPath(path);
    if ((await realpath(this.root)) !== this.root) throw new VectorError("E_ASSET_INTEGRITY");
    let current = this.root;
    for (const [index, segment] of segments.entries()) {
      current = join(current, segment);
      try {
        const info = await lstat(current);
        const last = index === segments.length - 1;
        if (info.isSymbolicLink() || (!last && !info.isDirectory())) throw new VectorError("E_ASSET_INTEGRITY");
        if (last && !info.isFile() && !info.isDirectory()) throw new VectorError("E_ASSET_INTEGRITY");
      } catch (error) {
        if (error instanceof VectorError) throw error;
        if (errorCode(error) === "ENOENT") break;
        throw new VectorError("E_ASSET_INTEGRITY");
      }
    }
    return join(this.root, ...segments);
  }

  /**
   * 処理名: 存在確認
   * 処理概要: 通常fileの有無を返す。
   * 実装理由: stage残存判定に使うため。
   * @param path - 論理path。
   * @returns 存在時true。
   */
  public async exists(path: string): Promise<boolean> {
    const real = await this.resolveSafe(path);
    try { return (await lstat(real)).isFile(); } catch { return false; }
  }

  /**
   * 処理名: 読込み
   * 処理概要: 通常fileを読む。欠損はundefined。
   * 実装理由: 検証前bytesを返さないため呼出し側で再検証する。
   * @param path - 論理path。
   * @returns bytes。
   */
  public async read(path: string): Promise<Uint8Array | undefined> {
    const real = await this.resolveSafe(path);
    try { return new Uint8Array(await readFile(real)); } catch (error) {
      if (errorCode(error) === "ENOENT") return undefined;
      throw new VectorError("E_ASSET_INTEGRITY");
    }
  }

  /**
   * 処理名: digest計算
   * 処理概要: sizeとSHA-256を返す。欠損はundefined。
   * 実装理由: 公開fileの完全性確認のため。
   * @param path - 論理path。
   * @returns 完全性情報。
   */
  public async digest(path: string): Promise<{ bytes: number; sha256: string } | undefined> {
    const bytes = await this.read(path);
    return bytes === undefined ? undefined : { bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
  }

  /**
   * 処理名: writer作成
   * 処理概要: 排他作成(wx)でstage fileを開く。
   * 実装理由: 既存fileを上書きしないため。
   * @param path - 論理path。
   * @returns writer。
   */
  public async createWriter(path: string): Promise<ArtifactWriter> {
    const real = await this.resolveSafe(path);
    await mkdir(dirname(real), { recursive: true });
    await this.resolveSafe(path);
    try {
      const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
      return new NodeArtifactWriter(await open(real, flags, 0o600), real, this.maxWriteBytes);
    } catch {
      throw new VectorError("E_ASSET_INTEGRITY");
    }
  }

  /**
   * 処理名: commit
   * 処理概要: 同一root内でrenameして公開する。
   * 実装理由: atomicに公開するため。
   * @param source - stage path。
   * @param target - 公開path。
   */
  public async commit(source: string, target: string): Promise<void> {
    const from = await this.resolveSafe(source);
    const to = await this.resolveSafe(target);
    await mkdir(dirname(to), { recursive: true });
    await this.resolveSafe(target);
    try { await rename(from, to); } catch { throw new VectorError("E_ASSET_INTEGRITY"); }
  }

  /**
   * 処理名: tree削除
   * 処理概要: 指定prefixだけを再帰削除する。
   * 実装理由: 他setやDBを消さないため。
   * @param prefix - 削除対象。
   */
  public async removeTree(prefix: string): Promise<void> {
    const real = await this.resolveSafe(prefix);
    await rm(real, { recursive: true, force: true });
  }

  /**
   * 処理名: 排他実行
   * 処理概要: .locks配下のmkdirでkey単位に排他する。
   * 実装理由: 同一artifact setのstage競合を防ぐため。
   * @param key - lock key。
   * @param action - 実行処理。
   * @returns 処理結果。
   */
  public async runExclusive<T>(key: string, action: () => Promise<T>): Promise<T> {
    const name = /^[0-9a-f]{64}$/.test(key) ? key : createHash("sha256").update(key).digest("hex");
    const locks = join(this.root, ".locks");
    await mkdir(locks, { recursive: true });
    const lock = join(locks, `${name}.lock`);
    const deadline = Date.now() + this.lockTimeoutMs;
    for (;;) {
      try { await mkdir(lock); break; } catch (error) {
        const code = errorCode(error);
        if ((code !== "EEXIST" && code !== "EPERM") || Date.now() >= deadline) throw new VectorError("E_ASSET_INTEGRITY");
        await new Promise<void>((done) => setTimeout(done, this.lockRetryMs));
      }
    }
    try { return await action(); } finally { await rmdir(lock).catch(() => undefined); }
  }
}

/**
 * 処理名: Node保存adapter作成
 * 処理概要: NodePersistentCacheStorage.createの関数入口。
 * 実装理由: tests/呼出し側の署名を保つため。
 * @param directory - cache root。
 * @param options - option。
 * @returns adapter。
 */
export function createNodePersistentCacheStorage(directory: string, options?: NodePersistentCacheOptions): Promise<NodePersistentCacheStorage> {
  return NodePersistentCacheStorage.create(directory, options);
}
