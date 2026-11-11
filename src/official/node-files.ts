import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { VectorError } from "../errors";

/**
 * 処理名: Node SQLite 正規化パス解決
 * 処理概要: NUL 文字を検証し、実在する親ディレクトリの realpath と basename を結合して正規化パスを生成する。
 * 実装理由: パストラバーサルやシンボリックリンク経由の予期せぬファイル破壊を防止するため。
 * @param filename - 対象ファイルパス。
 * @returns 正規化された絶対パス。
 */
export function canonicalNodeSqlitePath(filename: string): string {
  if (filename.includes("\0")) {
    throw new VectorError("E_STORAGE");
  }

  const resolved = path.resolve(filename);
  const dir = path.dirname(resolved);
  const base = path.basename(resolved);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // 親ディレクトリのシンボリックリンク検証
  let realDir: string;
  try {
    realDir = fs.realpathSync.native(dir);
  } catch {
    throw new VectorError("E_STORAGE");
  }

  return path.join(realDir, base);
}

/**
 * 処理名: 開かれたファイルの状態定義
 */
interface OpenedFileState {
  fd: number;
  canonicalPath: string;
  removeOnClose: boolean;
  main: boolean;
}

/**
 * 処理名: Node SQLite ファイルマネージャークラス
 * 処理概要: SQLite VFS からのファイル記述子 (fd) を管理し、メイン DB の排他ロック、同期 I/O、ゼロ埋め読み込み、一時ファイル削除を提供する。
 * 実装理由: Node.js 上で公式 SQLite のファイル I/O 契約を安全かつ厳格にエミュレートするため。
 */
export class NodeSqliteFiles {
  private readonly files = new Map<number, OpenedFileState>();
  private readonly mainLocks = new Map<string, number>();

  /**
   * 処理名: ファイルオープン
   * 処理概要: オプションに従ってファイルを開き、メイン DB の重複ロック検査およびシンボリックリンク検証を行う。
   * @param identifier - VFS が割り当てるファイル識別子。
   * @param filename - ファイルパス (null の場合は一時ファイル)。
   * @param options - オープンオプション。
   */
  public open(
    identifier: number,
    filename: string | null,
    options: { create: boolean; readonly: boolean; main: boolean; removeOnClose: boolean }
  ): void {
    let canonicalPath: string;
    let removeOnClose = options.removeOnClose;

    if (filename === null) {
      const tempName = `sqlite-temp-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`;
      canonicalPath = path.join(os.tmpdir(), tempName);
      removeOnClose = true;
    } else {
      canonicalPath = canonicalNodeSqlitePath(filename);
      if (options.main) {
        const existingHolder = this.mainLocks.get(canonicalPath);
        if (existingHolder !== undefined && existingHolder !== identifier) {
          throw new VectorError("E_DATABASE_LOCKED");
        }
        if (fs.existsSync(canonicalPath)) {
          const lstat = fs.lstatSync(canonicalPath);
          if (lstat.isSymbolicLink()) {
            throw new VectorError("E_STORAGE");
          }
        }
      }
    }

    let flags = fs.constants.O_RDWR;
    if (options.readonly) {
      flags = fs.constants.O_RDONLY;
    } else if (options.create) {
      flags = fs.constants.O_RDWR | fs.constants.O_CREAT;
    }

    let fd: number;
    try {
      fd = fs.openSync(canonicalPath, flags, 0o600);
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) {
        fs.closeSync(fd);
        throw new VectorError("E_STORAGE");
      }
    } catch (err: unknown) {
      if (err instanceof VectorError) throw err;
      throw new VectorError("E_STORAGE");
    }

    if (options.main) {
      this.mainLocks.set(canonicalPath, identifier);
    }

    this.files.set(identifier, {
      fd,
      canonicalPath,
      removeOnClose,
      main: options.main
    });
  }

  /**
   * 処理名: ファイル読み取り
   * 処理概要: 指定オフセットからバッファへ読み出し、ファイル末尾以降はゼロ埋めを行う。
   * @param identifier - ファイル識別子。
   * @param buffer - 読み込み先バッファ。
   * @param offset - 読み取り開始ファイルオフセット。
   * @returns 実際に読み取られた有効バイト数。
   */
  public read(identifier: number, buffer: Uint8Array, offset: number): number {
    const file = this.files.get(identifier);
    if (!file) throw new VectorError("E_STORAGE");

    let bytesRead = 0;
    try {
      bytesRead = fs.readSync(file.fd, buffer, 0, buffer.byteLength, offset);
    } catch {
      throw new VectorError("E_STORAGE");
    }

    if (bytesRead < buffer.byteLength) {
      buffer.fill(0, bytesRead);
    }
    return bytesRead;
  }

  /**
   * 処理名: ファイル書き込み
   * 処理概要: バッファの内容を指定オフセットへ書き込む。
   * @param identifier - ファイル識別子。
   * @param buffer - 書き込み元バッファ。
   * @param offset - 書き込み開始ファイルオフセット。
   */
  public write(identifier: number, buffer: Uint8Array, offset: number): void {
    const file = this.files.get(identifier);
    if (!file) throw new VectorError("E_STORAGE");

    try {
      fs.writeSync(file.fd, buffer, 0, buffer.byteLength, offset);
    } catch {
      throw new VectorError("E_STORAGE");
    }
  }

  /**
   * 処理名: ファイルディスク同期
   * 処理概要: ファイルの変更内容をディスクへフラッシュする。
   * @param identifier - ファイル識別子。
   */
  public sync(identifier: number): void {
    const file = this.files.get(identifier);
    if (!file) throw new VectorError("E_STORAGE");

    try {
      fs.fsyncSync(file.fd);
    } catch {
      throw new VectorError("E_STORAGE");
    }
  }

  /**
   * 処理名: ファイルサイズ切り捨て
   * 処理概要: ファイルサイズを指定バイト数へ切り詰める。
   * @param identifier - ファイル識別子。
   * @param size - 切り詰め後サイズ。
   */
  public truncate(identifier: number, size: number): void {
    const file = this.files.get(identifier);
    if (!file) throw new VectorError("E_STORAGE");

    try {
      fs.ftruncateSync(file.fd, size);
    } catch {
      throw new VectorError("E_STORAGE");
    }
  }

  /**
   * 処理名: ファイルサイズ取得
   * 処理概要: 現在のファイルサイズをバイト単位で返す。
   * @param identifier - ファイル識別子。
   * @returns ファイルサイズ。
   */
  public size(identifier: number): number {
    const file = this.files.get(identifier);
    if (!file) throw new VectorError("E_STORAGE");

    try {
      return fs.fstatSync(file.fd).size;
    } catch {
      throw new VectorError("E_STORAGE");
    }
  }

  /**
   * 処理名: ファイルアクセス確認
   * 処理概要: ファイルの存在および読み書き権限を確認する。
   * @param filename - ファイルパス。
   * @param writable - 書き込み権限が必要かどうか。
   * @returns アクセス可能なら true。
   */
  public accessible(filename: string, writable: boolean): boolean {
    try {
      const mode = writable ? fs.constants.W_OK : fs.constants.R_OK;
      fs.accessSync(filename, mode);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 処理名: ファイル削除
   * 処理概要: 指定されたファイルをディスクから削除する。
   * @param filename - ファイルパス。
   */
  public delete(filename: string): void {
    try {
      const canonical = canonicalNodeSqlitePath(filename);
      fs.unlinkSync(canonical);
    } catch {
      // 存在しない場合等は無視
    }
  }

  /**
   * 処理名: ファイルクローズ
   * 処理概要: ファイル記述子を閉じ、ロックを解放し、一時ファイルであれば削除する。
   * @param identifier - ファイル識別子。
   */
  public close(identifier: number): void {
    const file = this.files.get(identifier);
    if (!file) throw new VectorError("E_STORAGE");

    try {
      fs.closeSync(file.fd);
    } catch {
      // 無視
    }

    if (file.main) {
      this.mainLocks.delete(file.canonicalPath);
    }

    if (file.removeOnClose) {
      try {
        fs.unlinkSync(file.canonicalPath);
      } catch {
        // 無視
      }
    }

    this.files.delete(identifier);
  }

  /**
   * 処理名: 全ファイル破棄
   * 処理概要: 残存するすべてのオープンファイルをクローズし、一時ファイルを削除する。
   */
  public dispose(): void {
    for (const id of Array.from(this.files.keys())) {
      try {
        this.close(id);
      } catch {
        // 無視
      }
    }
  }
}
