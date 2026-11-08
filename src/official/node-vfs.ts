import { accessSync, constants, unlinkSync } from "node:fs";
import { randomFillSync } from "node:crypto";
import { NodeSqliteFiles } from "./node-files";
import { VectorError } from "../errors";

/**
 * 処理名: Node file VFSの登録
 * 処理概要: SQLite3公式Wasmランタイムへ非既定VFS "node-file" を登録する。
 * 実装理由: Node.js環境で公式oo1.DBからホストファイルシステムへの安全な永続化を提供するため。
 * @param sqlite3 - 公式sqlite3モジュールインスタンス
 * @returns VFS制御オブジェクト ({ close(): void })
 */
export function installNodeFileVfs(sqlite3: any): { close(): void } {
  const capi = sqlite3.capi;
  const wasm = sqlite3.wasm;

  if (capi.sqlite3_vfs_find("node-file")) {
    return {
      close: () => {
        capi.sqlite3_vfs_unregister(capi.sqlite3_vfs_find("node-file"));
      }
    };
  }

  const files = new NodeSqliteFiles();

  const ioMethods = {
    xClose: function (pFile: number) {
      try {
        files.close(pFile);
        return 0;
      } catch {
        return capi.SQLITE_IOERR;
      }
    },
    xRead: function (pFile: number, pDest: number, n: number, offset64: bigint | number) {
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
    xWrite: function (pFile: number, pSrc: number, n: number, offset64: bigint | number) {
      try {
        const heap = wasm.heap8u();
        const source = heap.subarray(Number(pSrc), Number(pSrc) + n);
        files.write(pFile, source, Number(offset64));
        return 0;
      } catch {
        return capi.SQLITE_IOERR_WRITE;
      }
    },
    xTruncate: function (pFile: number, sz64: bigint | number) {
      try {
        files.truncate(pFile, Number(sz64));
        return 0;
      } catch {
        return capi.SQLITE_IOERR_TRUNCATE;
      }
    },
    xSync: function (pFile: number, _flags: number) {
      try {
        files.sync(pFile);
        return 0;
      } catch {
        return capi.SQLITE_IOERR_FSYNC;
      }
    },
    xFileSize: function (pFile: number, pSz64: number) {
      try {
        const size = files.size(pFile);
        wasm.poke64(pSz64, BigInt(size));
        return 0;
      } catch {
        return capi.SQLITE_IOERR_FSTAT;
      }
    },
    xLock: function (_pFile: number, _lockType: number) {
      return 0;
    },
    xUnlock: function (_pFile: number, _lockType: number) {
      return 0;
    },
    xCheckReservedLock: function (_pFile: number, pOut: number) {
      wasm.poke32(pOut, 0);
      return 0;
    },
    xFileControl: function (_pFile: number, _opId: number, _pArg: number) {
      return capi.SQLITE_NOTFOUND;
    },
    xSectorSize: function (_pFile: number) {
      return 4096;
    },
    xDeviceCharacteristics: function (_pFile: number) {
      return 0;
    }
  };

  const nodeIoMethods = new capi.sqlite3_io_methods();
  nodeIoMethods.$iVersion = 1;
  sqlite3.vfs.installVfs({
    io: { struct: nodeIoMethods, methods: ioMethods }
  });

  const vfsMethods = {
    xOpen: function (
      _pVfs: number,
      zName: number,
      pFile: number,
      flags: number,
      pOutFlags: number
    ) {
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
      } catch (err: any) {
        if (err instanceof VectorError && err.code === "E_DATABASE_LOCKED") {
          return capi.SQLITE_BUSY;
        }
        return capi.SQLITE_CANTOPEN;
      }
    },
    xDelete: function (_pVfs: number, zName: number, _doSyncDir: number) {
      try {
        const filename = wasm.cstrToJs(zName);
        unlinkSync(filename);
        return 0;
      } catch {
        return capi.SQLITE_IOERR_DELETE;
      }
    },
    xAccess: function (_pVfs: number, zName: number, flags: number, pOut: number) {
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
    xFullPathname: function (_pVfs: number, zName: number, nOut: number, pOut: number) {
      const i = wasm.cstrncpy(pOut, zName, nOut);
      return i < nOut ? 0 : capi.SQLITE_CANTOPEN;
    },
    xRandomness: function (_pVfs: number, nOut: number, pOut: number) {
      const heap = wasm.heap8u();
      const target = heap.subarray(Number(pOut), Number(pOut) + nOut);
      randomFillSync(target);
      return nOut;
    },
    xSleep: function (_pVfs: number, _ms: number) {
      return 0;
    },
    xCurrentTime: function (_pVfs: number, pOut: number) {
      wasm.poke(pOut, 2440587.5 + Date.now() / 86400000, "double");
      return 0;
    },
    xCurrentTimeInt64: function (_pVfs: number, pOut: number) {
      wasm.poke(pOut, BigInt(Math.floor(2440587.5 * 86400000 + Date.now())), "i64");
      return 0;
    },
    xGetLastError: function (_pVfs: number, _nOut: number, _pOut: number) {
      return 0;
    }
  };

  const nodeVfs = new capi.sqlite3_vfs();
  nodeVfs.$iVersion = 1;
  nodeVfs.$szOsFile = capi.sqlite3_file.structInfo.sizeof;
  nodeVfs.$mxPathname = 1024;
  nodeVfs.addOnDispose(nodeVfs.$zName = wasm.allocCString("node-file"));

  sqlite3.vfs.installVfs({
    vfs: { struct: nodeVfs, methods: vfsMethods, asDefault: false }
  });

  return {
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
