import { accessSync, constants, unlinkSync } from "node:fs";
import { randomFillSync } from "node:crypto";
import { NodeSqliteFiles } from "./node-files";
import { VectorError } from "../errors";

/**
 * 処理名: Node VFS向けCAPIインターフェース
 * 処理概要: Node VFS登録に必要なSQLite C-APIメソッドおよび定数を定義する。
 * 実装理由: C-API呼び出しを安全に行うため。
 */
interface CapiMethods {
  sqlite3_vfs_find: (name: string) => number;
  sqlite3_vfs_unregister: (pVfs: number) => number;
  SQLITE_IOERR: number;
  SQLITE_IOERR_SHORT_READ: number;
  SQLITE_IOERR_READ: number;
  SQLITE_IOERR_WRITE: number;
  SQLITE_IOERR_TRUNCATE: number;
  SQLITE_IOERR_FSYNC: number;
  SQLITE_IOERR_FSTAT: number;
  SQLITE_NOTFOUND: number;
  SQLITE_OPEN_MAIN_DB: number;
  SQLITE_OPEN_CREATE: number;
  SQLITE_OPEN_READONLY: number;
  SQLITE_OPEN_DELETEONCLOSE: number;
  SQLITE_BUSY: number;
  SQLITE_CANTOPEN: number;
  SQLITE_IOERR_DELETE: number;
  SQLITE_ACCESS_READWRITE: number;
  SQLITE_ACCESS_READ: number;
  sqlite3_io_methods: new () => { $iVersion: number; pointer: number; dispose: () => void };
  sqlite3_file: (new (p: number) => { $pMethods: number; dispose: () => void }) & {
    structInfo: { sizeof: number };
  };
  sqlite3_vfs: new () => {
    $iVersion: number;
    $szOsFile: number;
    $mxPathname: number;
    $zName: number;
    pointer: number;
    addOnDispose: (arg: unknown) => void;
    dispose: () => void;
  };
}

/**
 * 処理名: Node VFS向けWasmインターフェース
 * 処理概要: Node VFS登録に必要なSQLite Wasm操作メソッドを定義する。
 * 実装理由: Wasmヒープ操作を安全に行うため。
 */
interface WasmMethods {
  heap8u: () => Uint8Array;
  peek8: (p: number) => number;
  cstrToJs: (p: number) => string;
  poke32: (p: number, v: number) => void;
  poke64: (p: number, v: bigint) => void;
  poke: (p: number, v: unknown, type: string) => void;
  cstrncpy: (pOut: number, zName: number, nOut: number) => number;
  allocCString: (str: string) => number;
}

/**
 * 処理名: Node VFS向けSQLiteインスタンス型
 * 処理概要: Node VFS登録に必要なSQLite Wasm C-APIおよびVFSインストーラを定義する。
 * 実装理由: sqlite3インスタンスへのアクセスを型安全に行うため。
 */
interface NodeVfsSqliteInstance {
  capi: CapiMethods;
  wasm: WasmMethods;
  vfs: {
    installVfs: (options: {
      io?: { struct: unknown; methods: Record<string, unknown> };
      vfs?: { struct: unknown; methods: Record<string, unknown>; asDefault?: boolean };
    }) => void;
  };
}

/**
 * 処理名: Node file VFSの登録
 * 処理概要: SQLite3公式Wasmランタイムへ非既定VFS "node-file" を登録する。
 * 実装理由: Node.js環境で公式oo1.DBからホストファイルシステムへの安全な永続化を提供するため。
 * @param sqlite3 公式sqlite3モジュールインスタンス。
 * @returns VFS制御オブジェクト。
 */
export function installNodeFileVfs(sqlite3: unknown): {
  /**
   * 処理名: VFS解放
   * 処理概要: 登録されたVFSおよび関連ファイルを解放する。
   * 実装理由: リソースリークを防止するため。
   */
  close(): void;
} {
  const sq = sqlite3 as NodeVfsSqliteInstance;
  const capi = sq.capi;
  const wasm = sq.wasm;

  if (capi.sqlite3_vfs_find("node-file")) {
    return {
      /**
       * 処理名: 既存VFS登録解除
       * 処理概要: 既に登録されているnode-file VFSの登録を解除する。
       * 実装理由: 二重登録時の安全なクリーンアップのため。
       */
      close: () => {
        capi.sqlite3_vfs_unregister(capi.sqlite3_vfs_find("node-file"));
      }
    };
  }

  const files = new NodeSqliteFiles();

  const ioMethods = {
    /**
     * 処理名: VFSファイルクローズ
     * 処理概要: 開かれているファイル識別子をクローズする。
     * 実装理由: SQLite VFS I/OメソッドのxCloseを実装するため。
     * @param pFile ファイルポインタ。
     * @returns 成功時0、失敗時エラーコード。
     */
    xClose: function (pFile: number): number {
      try {
        files.close(pFile);
        return 0;
      } catch {
        return capi.SQLITE_IOERR;
      }
    },
    /**
     * 処理名: VFSファイル読み込み
     * 処理概要: 指定オフセットからWasmヒープへファイル内容を読み込む。
     * 実装理由: SQLite VFS I/OメソッドのxReadを実装するため。
     * @param pFile ファイルポインタ。
     * @param pDest コピー先ヒープポインタ。
     * @param n 読み込みバイト数。
     * @param offset64 ファイルオフセット。
     * @returns 成功時0、部分読み込み時SHORT_READ、エラーコード。
     */
    xRead: function (pFile: number, pDest: number, n: number, offset64: bigint | number): number {
      try {
        const heap = wasm.heap8u();
        const target = heap.subarray(Number(pDest), Number(pDest) + n);
        const nRead = files.read(pFile, target, Number(offset64));
        if (nRead < n) {
          heap.fill(0, Number(pDest) + nRead, Number(pDest) + n);
          return capi.SQLITE_IOERR_SHORT_READ;
        }
        return 0;
      } catch {
        return capi.SQLITE_IOERR_READ;
      }
    },
    /**
     * 処理名: VFSファイル書き込み
     * 処理概要: Wasmヒープからファイルへ指定バイト数を書き込む。
     * 実装理由: SQLite VFS I/OメソッドのxWriteを実装するため。
     * @param pFile ファイルポインタ。
     * @param pSrc ソースヒープポインタ。
     * @param n 書き込みバイト数。
     * @param offset64 ファイルオフセット。
     * @returns 成功時0、失敗時エラーコード。
     */
    xWrite: function (pFile: number, pSrc: number, n: number, offset64: bigint | number): number {
      try {
        const heap = wasm.heap8u();
        const source = heap.subarray(Number(pSrc), Number(pSrc) + n);
        files.write(pFile, source, Number(offset64));
        return 0;
      } catch {
        return capi.SQLITE_IOERR_WRITE;
      }
    },
    /**
     * 処理名: VFSファイル切り詰め
     * 処理概要: ファイルサイズを指定長に切り詰める。
     * 実装理由: SQLite VFS I/OメソッドのxTruncateを実装するため。
     * @param pFile ファイルポインタ。
     * @param sz64 切り詰めサイズ。
     * @returns 成功時0、失敗時エラーコード。
     */
    xTruncate: function (pFile: number, sz64: bigint | number): number {
      try {
        files.truncate(pFile, Number(sz64));
        return 0;
      } catch {
        return capi.SQLITE_IOERR_TRUNCATE;
      }
    },
    /**
     * 処理名: VFSファイル同期
     * 処理概要: ファイルのディスク同期を実行する。
     * 実装理由: SQLite VFS I/OメソッドのxSyncを実装するため。
     * @param pFile ファイルポインタ。
     * @param _flags 同期フラグ。
     * @returns 成功時0、失敗時エラーコード。
     */
    xSync: function (pFile: number, _flags: number): number {
      try {
        files.sync(pFile);
        return 0;
      } catch {
        return capi.SQLITE_IOERR_FSYNC;
      }
    },
    /**
     * 処理名: VFSファイルサイズ取得
     * 処理概要: ファイルサイズを取得してWasmポインタへ書き込む。
     * 実装理由: SQLite VFS I/OメソッドのxFileSizeを実装するため。
     * @param pFile ファイルポインタ。
     * @param pSz64 出力先サイズポインタ。
     * @returns 成功時0、失敗時エラーコード。
     */
    xFileSize: function (pFile: number, pSz64: number): number {
      try {
        const size = files.size(pFile);
        wasm.poke64(pSz64, BigInt(size));
        return 0;
      } catch {
        return capi.SQLITE_IOERR_FSTAT;
      }
    },
    /**
     * 処理名: VFSファイルロック
     * 処理概要: ファイルロック要求をノーオペレーションで受容する。
     * 実装理由: SQLite VFS I/OメソッドのxLockを実装するため。
     * @param _pFile ファイルポインタ。
     * @param _lockType ロック種別。
     * @returns 常に0。
     */
    xLock: function (_pFile: number, _lockType: number): number {
      return 0;
    },
    /**
     * 処理名: VFSファイルロック解除
     * 処理概要: ファイルロック解除要求をノーオペレーションで受容する。
     * 実装理由: SQLite VFS I/OメソッドのxUnlockを実装するため。
     * @param _pFile ファイルポインタ。
     * @param _lockType ロック種別。
     * @returns 常に0。
     */
    xUnlock: function (_pFile: number, _lockType: number): number {
      return 0;
    },
    /**
     * 処理名: VFSリザーブロック確認
     * 処理概要: リザーブロックの有無を確認して結果を出力ポインタへ書き込む。
     * 実装理由: SQLite VFS I/OメソッドのxCheckReservedLockを実装するため。
     * @param _pFile ファイルポインタ。
     * @param pOut 出力ポインタ。
     * @returns 常に0。
     */
    xCheckReservedLock: function (_pFile: number, pOut: number): number {
      wasm.poke32(pOut, 0);
      return 0;
    },
    /**
     * 処理名: VFSファイル制御
     * 処理概要: 未サポートのファイル制御コマンドにNOTFOUNDを返す。
     * 実装理由: SQLite VFS I/OメソッドのxFileControlを実装するため。
     * @param _pFile ファイルポインタ。
     * @param _opId 制御コマンドID。
     * @param _pArg 引数ポインタ。
     * @returns NOTFOUNDエラーコード。
     */
    xFileControl: function (_pFile: number, _opId: number, _pArg: number): number {
      return capi.SQLITE_NOTFOUND;
    },
    /**
     * 処理名: VFSセクターサイズ取得
     * 処理概要: デフォルトセクターサイズ4096バイトを返す。
     * 実装理由: SQLite VFS I/OメソッドのxSectorSizeを実装するため。
     * @param _pFile ファイルポインタ。
     * @returns セクターサイズ4096。
     */
    xSectorSize: function (_pFile: number): number {
      return 4096;
    },
    /**
     * 処理名: VFSデバイス特性取得
     * 処理概要: デバイス特性フラグを返す。
     * 実装理由: SQLite VFS I/OメソッドのxDeviceCharacteristicsを実装するため。
     * @param _pFile ファイルポインタ。
     * @returns 特性フラグ0。
     */
    xDeviceCharacteristics: function (_pFile: number): number {
      return 0;
    }
  };

  const nodeIoMethods = new capi.sqlite3_io_methods();
  nodeIoMethods.$iVersion = 1;
  sq.vfs.installVfs({
    io: { struct: nodeIoMethods, methods: ioMethods }
  });

  const vfsMethods = {
    /**
     * 処理名: VFSファイルオープン
     * 処理概要: SQLiteからのファイルオープン要求を処理し、VFSファイルを初期化する。
     * 実装理由: SQLite VFSのxOpenを実装するため。
     * @param _pVfs VFSポインタ。
     * @param zName ファイル名ポインタ。
     * @param pFile ファイル構造体ポインタ。
     * @param flags オープンフラグ。
     * @param pOutFlags 出力フラグポインタ。
     * @returns 成功時0、ロック時BUSY、失敗時CANTOPEN。
     */
    xOpen: function (
      _pVfs: number,
      zName: number,
      pFile: number,
      flags: number,
      pOutFlags: number
    ): number {
      try {
        const filename = zName && wasm.peek8(zName) ? wasm.cstrToJs(zName) : null;
        const isMain = !!(flags & capi.SQLITE_OPEN_MAIN_DB);
        const create = !!(flags & capi.SQLITE_OPEN_CREATE);
        const readonly = !!(flags & capi.SQLITE_OPEN_READONLY);
        const removeOnClose = !!(flags & capi.SQLITE_OPEN_DELETEONCLOSE);

        files.open(pFile, filename, {
          create,
          readonly,
          main: isMain,
          removeOnClose
        });

        const sq3File = new capi.sqlite3_file(pFile);
        sq3File.$pMethods = nodeIoMethods.pointer;
        sq3File.dispose();

        wasm.poke32(pOutFlags, flags);
        return 0;
      } catch (err: unknown) {
        if (err instanceof VectorError && err.code === "E_DATABASE_LOCKED") {
          return capi.SQLITE_BUSY;
        }
        return capi.SQLITE_CANTOPEN;
      }
    },
    /**
     * 処理名: VFSファイル削除
     * 処理概要: 指定されたファイルパスのファイルを削除する。
     * 実装理由: SQLite VFSのxDeleteを実装するため。
     * @param _pVfs VFSポインタ。
     * @param zName ファイル名ポインタ。
     * @param _doSyncDir ディレクトリ同期フラグ。
     * @returns 成功時0、失敗時エラーコード。
     */
    xDelete: function (_pVfs: number, zName: number, _doSyncDir: number): number {
      try {
        const filename = wasm.cstrToJs(zName);
        unlinkSync(filename);
        return 0;
      } catch {
        return capi.SQLITE_IOERR_DELETE;
      }
    },
    /**
     * 処理名: VFSファイルアクセス確認
     * 処理概要: ファイルの存在および要求アクセス権限を確認してポインタへ書き込む。
     * 実装理由: SQLite VFSのxAccessを実装するため。
     * @param _pVfs VFSポインタ。
     * @param zName ファイル名ポインタ。
     * @param flags アクセス要求フラグ。
     * @param pOut 結果出力ポインタ。
     * @returns 成功時0。
     */
    xAccess: function (_pVfs: number, zName: number, flags: number, pOut: number): number {
      try {
        const filename = wasm.cstrToJs(zName);
        let mode = constants.F_OK;
        if (flags & capi.SQLITE_ACCESS_READWRITE) {
          mode = constants.R_OK | constants.W_OK;
        } else if (flags & capi.SQLITE_ACCESS_READ) {
          mode = constants.R_OK;
        }
        accessSync(filename, mode);
        wasm.poke32(pOut, 1);
      } catch {
        wasm.poke32(pOut, 0);
      }
      return 0;
    },
    /**
     * 処理名: VFSフルパス解決
     * 処理概要: 指定されたパスを正規化バッファへコピーする。
     * 実装理由: SQLite VFSのxFullPathnameを実装するため。
     * @param _pVfs VFSポインタ。
     * @param zName ファイル名ポインタ。
     * @param nOut 出力バッファサイズ。
     * @param pOut 出力先ポインタ。
     * @returns 成功時0、バッファ不足時CANTOPEN。
     */
    xFullPathname: function (_pVfs: number, zName: number, nOut: number, pOut: number): number {
      const i = wasm.cstrncpy(pOut, zName, nOut);
      return i < nOut ? 0 : capi.SQLITE_CANTOPEN;
    },
    /**
     * 処理名: VFS乱数生成
     * 処理概要: 暗号論的擬似乱数をWasmヒープに書き出す。
     * 実装理由: SQLite VFSのxRandomnessを実装するため。
     * @param _pVfs VFSポインタ。
     * @param nOut 生成バイト数。
     * @param pOut 出力先ポインタ。
     * @returns 書き込まれたバイト数。
     */
    xRandomness: function (_pVfs: number, nOut: number, pOut: number): number {
      const heap = wasm.heap8u();
      const target = heap.subarray(Number(pOut), Number(pOut) + nOut);
      randomFillSync(target);
      return nOut;
    },
    /**
     * 処理名: VFSスリープ
     * 処理概要: スリープ要求をノーオペレーションで受容する。
     * 実装理由: SQLite VFSのxSleepを実装するため。
     * @param _pVfs VFSポインタ。
     * @param _ms スリープミリ秒。
     * @returns 常に0。
     */
    xSleep: function (_pVfs: number, _ms: number): number {
      return 0;
    },
    /**
     * 処理名: VFS現在時刻取得
     * 処理概要: 現在ユリウス日をdouble精度でWasmポインタへ書き込む。
     * 実装理由: SQLite VFSのxCurrentTimeを実装するため。
     * @param _pVfs VFSポインタ。
     * @param pOut 出力先ポインタ。
     * @returns 成功時0。
     */
    xCurrentTime: function (_pVfs: number, pOut: number): number {
      wasm.poke(pOut, 2440587.5 + Date.now() / 86400000, "double");
      return 0;
    },
    /**
     * 処理名: VFS現在時刻i64取得
     * 処理概要: 現在ユリウス日ミリ秒をi64でWasmポインタへ書き込む。
     * 実装理由: SQLite VFSのxCurrentTimeInt64を実装するため。
     * @param _pVfs VFSポインタ。
     * @param pOut 出力先ポインタ。
     * @returns 成功時0。
     */
    xCurrentTimeInt64: function (_pVfs: number, pOut: number): number {
      wasm.poke(pOut, BigInt(Math.floor(2440587.5 * 86400000 + Date.now())), "i64");
      return 0;
    },
    /**
     * 処理名: VFS最後のエラー取得
     * 処理概要: エラー文字列を書き込まず常に0を返す。
     * 実装理由: SQLite VFSのxGetLastErrorを実装するため。
     * @param _pVfs VFSポインタ。
     * @param _nOut バッファサイズ。
     * @param _pOut 出力先ポインタ。
     * @returns 常に0。
     */
    xGetLastError: function (_pVfs: number, _nOut: number, _pOut: number): number {
      return 0;
    }
  };

  const nodeVfs = new capi.sqlite3_vfs();
  nodeVfs.$iVersion = 1;
  nodeVfs.$szOsFile = capi.sqlite3_file.structInfo.sizeof;
  nodeVfs.$mxPathname = 1024;
  nodeVfs.addOnDispose(nodeVfs.$zName = wasm.allocCString("node-file"));

  sq.vfs.installVfs({
    vfs: { struct: nodeVfs, methods: vfsMethods, asDefault: false }
  });

  return {
    /**
     * 処理名: Node VFSクローズ
     * 処理概要: VFS登録を解除しファイルリソースを破棄する。
     * 実装理由: データベース終了時に安全にクリーンアップするため。
     */
    close: () => {
      files.dispose();
      try {
        capi.sqlite3_vfs_unregister(nodeVfs.pointer);
        nodeVfs.dispose();
        nodeIoMethods.dispose();
      } catch {
        // ignore
      }
    }
  };
}
