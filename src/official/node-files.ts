import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeSync
} from "node:fs";
import { createServer, type Server } from "node:net";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { VectorError } from "../errors";

/**
 * 処理名: Node SQLiteファイルオープンオプション
 * 処理概要: ファイルオープン時の新規作成・読み取り専用・主DB・クローズ時削除フラグを保持する。
 * 実装理由: VFSファイルオープン時の要求動作を制御するため。
 */
export interface NodeSqliteFileOptions {
  create: boolean;
  readonly: boolean;
  main: boolean;
  removeOnClose: boolean;
}

/**
 * 処理名: オープンファイルエントリ型
 * 処理概要: オープンされたファイルディスクリプタとロックサーバー情報を保持する。
 * 実装理由: 開いているファイルのライフサイクルおよび排他ロックを管理するため。
 */
interface OpenFileEntry {
  fd: number;
  filename: string;
  isTemp: boolean;
  removeOnClose: boolean;
  lockServer?: Server | undefined;
}

/**
 * 処理名: Node SQLite正規化パス解決
 * 処理概要: ファイルパスのNUL文字を検証し、実ディレクトリパスを解決して正規化された絶対パスを返す。
 * 実装理由: シンボリックリンクや相対パスによるパス曖昧性を解消するため。
 * @param filename 対象ファイルパス。
 * @returns 正規化された絶対パス。
 */
export function canonicalNodeSqlitePath(filename: string): string {
  if (filename.includes("\0")) throw new VectorError("E_STORAGE");
  const full = resolve(filename);
  const dir = dirname(full);
  try {
    const realDir = realpathSync.native(dir);
    return join(realDir, full.slice(dir.length + (dir.endsWith("\\") || dir.endsWith("/") ? 0 : 1)));
  } catch {
    return full;
  }
}

/**
 * 処理名: Node SQLiteファイルマネージャ
 * 処理概要: Node.js環境におけるSQLite VFSファイルI/Oおよび名前付きパイプによる排他ロックを管理する。
 * 実装理由: Node環境での安全なSQLiteファイル操作とプロセス間排他制御を実現するため。
 */
export class NodeSqliteFiles {
  private readonly entries = new Map<number, OpenFileEntry>();
  private readonly locks = new Map<string, Server>();

  /**
   * 処理名: ターゲットパス解決
   * 処理概要: 指定パスまたは一時ファイルパスを解決し、シンボリックリンクを検証する。
   * 実装理由: 一時DBおよび通常DBのファイルパスを安全に決定するため。
   * @param filename 指定ファイルパス。
   * @returns 解決されたターゲットパスと一時ファイル判定。
   */
  private resolveTargetPath(filename: string | null): { targetPath: string; isTemp: boolean } {
    if (filename === null) {
      const rnd = Math.random().toString(36).slice(2);
      return {
        targetPath: join(tmpdir(), `sqlite-temp-${process.pid}-${rnd}.tmp`),
        isTemp: true
      };
    }
    if (filename.includes("\0")) throw new VectorError("E_STORAGE");
    const targetPath = canonicalNodeSqlitePath(filename);
    try {
      const stat = lstatSync(targetPath, { throwIfNoEntry: false });
      if (stat && stat.isSymbolicLink()) {
        throw new VectorError("E_STORAGE");
      }
    } catch (err) {
      if (err instanceof VectorError) throw err;
    }
    return { targetPath, isTemp: false };
  }

  /**
   * 処理名: ファイルロックサーバー取得
   * 処理概要: メインDBファイルに対する排他ロックパイプサーバーを起動して登録する。
   * 実装理由: 同一DBに対する複数プロセスの多重オープンによる破損を防ぐため。
   * @param targetPath ロック対象のファイルパス。
   * @returns 起動されたロックサーバー。
   */
  private acquireLockServer(targetPath: string): Server {
    const key = createHash("sha256")
      .update(process.platform === "win32" ? targetPath.toLowerCase() : targetPath)
      .digest("hex");
    const pipeName = process.platform === "win32"
      ? `\\\\.\\pipe\\svw-sqlite-${key}`
      : `\0svw-sqlite-${key}`;

    if (this.locks.has(pipeName)) {
      throw new VectorError("E_DATABASE_LOCKED");
    }

    const server = createServer();
    try {
      server.listen(pipeName);
    } catch (e: unknown) {
      const err = e as { code?: string } | null;
      if (err?.code === "EADDRINUSE") {
        throw new VectorError("E_DATABASE_LOCKED");
      }
      throw new VectorError("E_STORAGE");
    }
    server.on("error", () => {});
    this.locks.set(pipeName, server);
    return server;
  }

  /**
   * 処理名: ファイルオープンフラグ計算
   * 処理概要: オープションに応じたNode.js fsオープンフラグ定数を計算する。
   * 実装理由: 読み取り専用や新規作成指定をOSレベルのフラグへマッピングするため。
   * @param options ファイルオープンオプション。
   * @returns fsオープン定数フラグ。
   */
  private computeFileFlags(options: NodeSqliteFileOptions): number {
    if (options.readonly) {
      return constants.O_RDONLY;
    }
    if (options.create) {
      return constants.O_RDWR | constants.O_CREAT;
    }
    return constants.O_RDWR;
  }

  /**
   * 処理名: ファイルオープン
   * 処理概要: 指定された識別子でファイルを開き、エントリマップに登録する。
   * 実装理由: VFSファイル記述子とOSファイルディスクリプタを紐付けるため。
   * @param identifier VFSファイル識別子。
   * @param filename ファイルパスまたは一時DBの場合null。
   * @param options オープンオプション。
   */
  public open(
    identifier: number,
    filename: string | null,
    options: NodeSqliteFileOptions
  ): void {
    if (this.entries.has(identifier)) {
      throw new VectorError("E_STORAGE");
    }

    const { targetPath, isTemp } = this.resolveTargetPath(filename);
    const lockServer = (!isTemp && options.main) ? this.acquireLockServer(targetPath) : undefined;
    const flags = this.computeFileFlags(options);

    try {
      mkdirSync(dirname(targetPath), { recursive: true });
      const fd = openSync(targetPath, flags, 0o600);
      this.entries.set(identifier, {
        fd,
        filename: targetPath,
        isTemp,
        removeOnClose: options.removeOnClose || isTemp,
        lockServer
      });
    } catch {
      this.cleanupLockServer(lockServer);
      throw new VectorError("E_STORAGE");
    }
  }

  /**
   * 処理名: エントリ取得
   * 処理概要: 識別子に対応するオープンファイルエントリを取得する。
   * 実装理由: 存在しないディスクリプタへの誤アクセスを防ぐため。
   * @param identifier VFSファイル識別子。
   * @returns ファイルエントリ。
   */
  private getEntry(identifier: number): OpenFileEntry {
    const entry = this.entries.get(identifier);
    if (!entry) throw new VectorError("E_STORAGE");
    return entry;
  }

  /**
   * 処理名: ファイル読み取り
   * 処理概要: 指定オフセットからバッファへファイル内容を読み込む。
   * 実装理由: SQLite VFSのxRead操作を実現するため。
   * @param identifier VFSファイル識別子。
   * @param output 読み込み先バッファ。
   * @param offset ファイル内オフセット。
   * @returns 読み込まれたバイト数。
   */
  public read(identifier: number, output: Uint8Array, offset: number): number {
    const entry = this.getEntry(identifier);
    try {
      const bytesRead = readSync(entry.fd, output, 0, output.byteLength, offset);
      if (bytesRead < output.byteLength) {
        output.fill(0, bytesRead);
      }
      return bytesRead;
    } catch {
      throw new VectorError("E_STORAGE");
    }
  }

  /**
   * 処理名: ファイル書き込み
   * 処理概要: 指定オフセットへバッファの内容を全量書き出す。
   * 実装理由: SQLite VFSのxWrite操作を実現するため。
   * @param identifier VFSファイル識別子。
   * @param input 書き込み元バッファ。
   * @param offset ファイル内オフセット。
   */
  public write(identifier: number, input: Uint8Array, offset: number): void {
    const entry = this.getEntry(identifier);
    try {
      let written = 0;
      while (written < input.byteLength) {
        const n = writeSync(entry.fd, input, written, input.byteLength - written, offset + written);
        if (n <= 0) throw new VectorError("E_STORAGE");
        written += n;
      }
    } catch {
      throw new VectorError("E_STORAGE");
    }
  }

  /**
   * 処理名: ファイル同期
   * 処理概要: メモリ内の変更をディスクにフラッシュする。
   * 実装理由: SQLite VFSのxSync操作を実現するため。
   * @param identifier VFSファイル識別子。
   */
  public sync(identifier: number): void {
    const entry = this.getEntry(identifier);
    try {
      fsyncSync(entry.fd);
    } catch {
      throw new VectorError("E_STORAGE");
    }
  }

  /**
   * 処理名: ファイル切り詰め
   * 処理概要: ファイルサイズを指定長に変更する。
   * 実装理由: SQLite VFSのxTruncate操作を実現するため。
   * @param identifier VFSファイル識別子。
   * @param size 切り詰め後のファイルサイズ。
   */
  public truncate(identifier: number, size: number): void {
    const entry = this.getEntry(identifier);
    try {
      ftruncateSync(entry.fd, size);
    } catch {
      throw new VectorError("E_STORAGE");
    }
  }

  /**
   * 処理名: ファイルサイズ取得
   * 処理概要: 現在のファイルサイズをバイト数で取得する。
   * 実装理由: SQLite VFSのxFileSize操作を実現するため。
   * @param identifier VFSファイル識別子。
   * @returns ファイルサイズ。
   */
  public size(identifier: number): number {
    const entry = this.getEntry(identifier);
    try {
      return fstatSync(entry.fd).size;
    } catch {
      throw new VectorError("E_STORAGE");
    }
  }

  /**
   * 処理名: ファイルアクセス確認
   * 処理概要: 指定されたファイルが存在し、要求モードでアクセス可能か確認する。
   * 実装理由: SQLite VFSのxAccess操作を実現するため。
   * @param filename 対象ファイルパス。
   * @param writable 書き込み可能である必要があるか否か。
   * @returns アクセス可能ならtrue。
   */
  public accessible(filename: string, writable: boolean): boolean {
    try {
      const mode = writable ? constants.R_OK | constants.W_OK : constants.R_OK;
      const fd = openSync(filename, mode);
      closeSync(fd);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 処理名: ファイル削除
   * 処理概要: 指定されたファイルをディスクから削除する。
   * 実装理由: SQLite VFSのxDelete操作を実現するため。
   * @param filename 削除対象ファイルパス。
   * @param _synchronize 同期フラグ（未使用）。
   */
  public delete(filename: string, _synchronize?: boolean): void {
    try {
      unlinkSync(filename);
    } catch {
      throw new VectorError("E_STORAGE");
    }
  }

  /**
   * 処理名: ロックサーバー解放
   * 処理概要: ロックサーバーをクローズし、内部マップから登録を解除する。
   * 実装理由: DBクローズ時またはオープン失敗時にパイプロックを解放するため。
   * @param lockServer 解放対象のサーバー。
   */
  private cleanupLockServer(lockServer: Server | undefined): void {
    if (!lockServer) return;
    lockServer.close();
    for (const [k, v] of this.locks.entries()) {
      if (v === lockServer) this.locks.delete(k);
    }
  }

  /**
   * 処理名: ファイルクローズ
   * 処理概要: ファイルディスクリプタを閉じ、一時ファイルやロックリソースをクリーンアップする。
   * 実装理由: SQLite VFSのxClose操作を実現するため。
   * @param identifier VFSファイル識別子。
   */
  public close(identifier: number): void {
    const entry = this.entries.get(identifier);
    if (!entry) throw new VectorError("E_STORAGE");
    this.entries.delete(identifier);
    try {
      closeSync(entry.fd);
    } catch {
      // ignore
    } finally {
      this.cleanupLockServer(entry.lockServer);
      if (entry.removeOnClose) {
        try { unlinkSync(entry.filename); } catch {}
      }
    }
  }

  /**
   * 処理名: 全リソース破棄
   * 処理概要: 開いている全ファイルをクローズし、保持しているリソースを解放する。
   * 実装理由: シャットダウン時にリークを防ぐため。
   */
  public dispose(): void {
    for (const identifier of Array.from(this.entries.keys())) {
      this.close(identifier);
    }
  }
}
