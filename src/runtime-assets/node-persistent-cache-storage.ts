import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { VectorError } from "../errors";
import {
  ArtifactWriter,
  PersistentCacheStorage
} from "./persistent-model-cache";

/**
 * 処理名: Node ストレージ設定オプション
 * 処理概要: 最大書き込みバイト数、ロック再試行間隔、ロックタイムアウトを定義する。
 * 実装理由: I/O 制限およびプロセス間ファイルロック競合制御のため。
 */
export interface NodeStorageOptions {
  maxWriteBytes?: number;
  lockRetryMs?: number;
  lockTimeoutMs?: number;
}

/**
 * 処理名: NodePersistentCacheStorage クラス
 * 処理概要: Node.js のファイルシステム API を用いて永続モデルキャッシュストレージを提供する。
 * 実装理由: パストラバーサル防止、シンボリックリンク排除、アトミックコミット、ファイルロックを実現するため。
 */
export class NodePersistentCacheStorage implements PersistentCacheStorage {
  private readonly rootDir: string;
  private readonly maxWriteBytes: number;
  private readonly lockRetryMs: number;
  private readonly lockTimeoutMs: number;
  private readonly inProcessLocks = new Map<string, Promise<unknown>>();

  /**
   * 処理名: NodePersistentCacheStorage コンストラクタ
   * 処理概要: キャッシュルートディレクトリとオプションパラメータを初期化する。
   * 実装理由: ストレージのルート絶対パスおよび制限値を固定するため。
   * @param directory - キャッシュルートディレクトリパス。
   * @param options - ストレージオプション。
   */
  constructor(directory: string, options?: NodeStorageOptions) {
    this.rootDir = path.resolve(directory);
    this.maxWriteBytes = options?.maxWriteBytes ?? 1024 * 1024;
    this.lockRetryMs = options?.lockRetryMs ?? 25;
    this.lockTimeoutMs = options?.lockTimeoutMs ?? 120000;
  }

  /**
   * 処理名: ファクトリメソッド
   * 処理概要: ストレージインスタンスを生成して返す。
   * 実装理由: 非同期ファクトリおよびクラスファクトリ双方の呼び出し規約に対応するため。
   * @param directory - キャッシュルートディレクトリ。
   * @param options - ストレージオプション。
   * @returns NodePersistentCacheStorage インスタンス。
   */
  public static async create(
    directory: string,
    options?: NodeStorageOptions
  ): Promise<NodePersistentCacheStorage> {
    const absDir = path.resolve(directory);
    await fsPromises.mkdir(absDir, { recursive: true });
    return new NodePersistentCacheStorage(absDir, options);
  }

  /**
   * 処理名: 論理パスの安全な解決と境界検証
   * 処理概要: 相対パスの不正文字・traversal・symlink を検証し、ルート配下の絶対パスを返す。
   * 実装理由: キャッシュディレクトリ外への I/O 漏洩およびジャンクション悪用を防止するため。
   * @param logicalPath - 検証対象の論理パス。
   * @returns 安全に解決された絶対パス。
   */
  private resolveSafePath(logicalPath: string): string {
    if (typeof logicalPath !== "string" || logicalPath.trim().length === 0) {
      throw new VectorError("E_ASSET_INTEGRITY");
    }
    if (path.isAbsolute(logicalPath) || logicalPath.includes("\\") || /^[A-Za-z]:/.test(logicalPath)) {
      throw new VectorError("E_ASSET_INTEGRITY");
    }

    const segments = logicalPath.split("/");
    for (const seg of segments) {
      if (seg === "" || seg === "." || seg === ".." || !/^[A-Za-z0-9._-]+$/.test(seg)) {
        throw new VectorError("E_ASSET_INTEGRITY");
      }
    }

    const fullPath = path.resolve(this.rootDir, logicalPath);
    if (!fullPath.startsWith(this.rootDir + path.sep) && fullPath !== this.rootDir) {
      throw new VectorError("E_ASSET_INTEGRITY");
    }

    // パス中に symlink / junction が存在しないかルートから親方向へ検証
    let cur = this.rootDir;
    for (const seg of segments) {
      cur = path.join(cur, seg);
      if (fs.existsSync(cur)) {
        const lstat = fs.lstatSync(cur);
        if (lstat.isSymbolicLink()) {
          throw new VectorError("E_ASSET_INTEGRITY");
        }
      }
    }

    return fullPath;
  }

  /**
   * 処理名: ファイル存在確認
   * 処理概要: 指定論理パスの実在を確認する。
   * 実装理由: キャッシュファイルの存在を非同期に問い合わせるため。
   * @param logicalPath - 論理パス。
   * @returns 存在時 true。
   */
  public async exists(logicalPath: string): Promise<boolean> {
    try {
      const fullPath = this.resolveSafePath(logicalPath);
      return fs.existsSync(fullPath);
    } catch {
      return false;
    }
  }

  /**
   * 処理名: ファイル読み出し
   * 処理概要: 指定論理パスの内容を Uint8Array で読み取る。
   * 実装理由: キャッシュ資材の完全なバイト配列を取得するため。
   * @param logicalPath - 論理パス。
   * @returns 読み取られたバイト配列、または非存在時 undefined。
   */
  public async read(logicalPath: string): Promise<Uint8Array | undefined> {
    const fullPath = this.resolveSafePath(logicalPath);
    if (!fs.existsSync(fullPath)) {
      return undefined;
    }
    const buf = await fsPromises.readFile(fullPath);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  /**
   * 処理名: ファイルダイジェスト計算
   * 処理概要: ファイルのバイト長と SHA-256 ダイジェストを計算して返す。
   * 実装理由: ストレージ上の資材完全性を決定論的に照合するため。
   * @param logicalPath - 論理パス。
   * @returns 完全性情報、または非存在時 undefined。
   */
  public async digest(logicalPath: string): Promise<{ bytes: number; sha256: string } | undefined> {
    const fullPath = this.resolveSafePath(logicalPath);
    if (!fs.existsSync(fullPath)) {
      return undefined;
    }
    const stat = await fsPromises.stat(fullPath);
    const content = await fsPromises.readFile(fullPath);
    const sha = crypto.createHash("sha256").update(content).digest("hex");
    return { bytes: stat.size, sha256: sha };
  }

  /**
   * 処理名: ライター生成
   * 処理概要: 指定パスへのチャンク書き込みを行う ArtifactWriter を作成する。
   * 実装理由: 制限付き容量単位での書き込みと安全なアボートを管理するため。
   * @param logicalPath - 出力先論理パス。
   * @returns ArtifactWriter インスタンス。
   */
  public async createWriter(logicalPath: string): Promise<ArtifactWriter> {
    const fullPath = this.resolveSafePath(logicalPath);
    await fsPromises.mkdir(path.dirname(fullPath), { recursive: true });

    // 親ディレクトリの symlink 再検証
    this.resolveSafePath(logicalPath);

    const handle = await fsPromises.open(fullPath, "w");
    const maxBytes = this.maxWriteBytes;

    return {
      write: async (chunk: Uint8Array): Promise<void> => {
        if (chunk.byteLength > maxBytes) {
          throw new VectorError("E_ASSET_INTEGRITY");
        }
        await handle.write(chunk);
      },
      close: async (): Promise<void> => {
        await handle.sync();
        await handle.close();
      },
      abort: async (): Promise<void> => {
        try {
          await handle.close();
        } catch {}
        try {
          await fsPromises.unlink(fullPath);
        } catch {}
      }
    };
  }

  /**
   * 処理名: アトミックコミット
   * 処理概要: ステージングファイルを目的の公開パスへアトミックに移動（置換）する。
   * 実装理由: 途中書き込み状態を外部に露出させず、一貫した公開状態へ切り替えるため。
   * @param sourcePath - 移動元論理パス。
   * @param targetPath - 移動先論理パス。
   */
  public async commit(sourcePath: string, targetPath: string): Promise<void> {
    const src = this.resolveSafePath(sourcePath);
    const dst = this.resolveSafePath(targetPath);
    await fsPromises.mkdir(path.dirname(dst), { recursive: true });
    this.resolveSafePath(targetPath);

    // Windows で dst が既に存在する場合のエラー回避
    try {
      if (fs.existsSync(dst)) {
        await fsPromises.unlink(dst);
      }
      await fsPromises.rename(src, dst);
    } catch {
      await fsPromises.copyFile(src, dst);
      await fsPromises.unlink(src);
    }
  }

  /**
   * 処理名: ツリー削除
   * 処理概要: 指定論理プレフィックス配下のファイルおよびディレクトリを再帰的に削除する。
   * 実装理由: ステージング領域の完全クリーンアップのため。
   * @param prefix - 削除対象論理プレフィックス。
   */
  public async removeTree(prefix: string): Promise<void> {
    const fullPath = this.resolveSafePath(prefix);
    await fsPromises.rm(fullPath, { recursive: true, force: true });
  }

  /**
   * 処理名: 排他実行
   * 処理概要: ファイルシステムディレクトリロックを用いて同一キーの処理を直列化実行する。
   * 実装理由: 同一アーティファクトセットに対する複数プロセスの並行取得競合を防止するため。
   * @param key - 排他識別キー。
   * @param action - 実行処理関数。
   * @returns 処理結果の Promise。
   */
  public async runExclusive<T>(key: string, action: () => Promise<T>): Promise<T> {
    const prev = this.inProcessLocks.get(key) ?? Promise.resolve();
    let unlock: () => void = () => {};
    const gate = new Promise<void>((r) => { unlock = r; });
    this.inProcessLocks.set(key, prev.then(() => gate));

    await prev;

    const lockDir = path.resolve(this.rootDir, ".locks", `${key}.lock`);
    await fsPromises.mkdir(path.dirname(lockDir), { recursive: true });

    const deadline = performance.now() + this.lockTimeoutMs;
    let acquired = false;

    while (!acquired) {
      try {
        await fsPromises.mkdir(lockDir);
        acquired = true;
      } catch (err: unknown) {
        const code = (err as { code?: string })?.code;
        if (code === "EEXIST" || code === "EPERM" || code === "EACCES") {
          if (performance.now() >= deadline) {
            unlock();
            throw new VectorError("E_ASSET_INTEGRITY");
          }
          await new Promise<void>((r) => setTimeout(r, this.lockRetryMs));
        } else {
          unlock();
          throw new VectorError("E_ASSET_INTEGRITY");
        }
      }
    }

    try {
      return await action();
    } finally {
      try {
        await fsPromises.rm(lockDir, { recursive: true, force: true });
      } catch {}
      unlock();
    }
  }
}

/**
 * 処理名: Node 永続キャッシュストレージ生成ファクトリ
 * 処理概要: NodePersistentCacheStorage をインスタンス化して返す。
 * 実装理由: 外部からの簡潔な生成 API を提供するため。
 * @param directory - キャッシュディレクトリパス。
 * @param options - オプション設定。
 * @returns PersistentCacheStorage インスタンス。
 */
export async function createNodePersistentCacheStorage(
  directory: string,
  options?: NodeStorageOptions
): Promise<PersistentCacheStorage> {
  return NodePersistentCacheStorage.create(directory, options);
}
