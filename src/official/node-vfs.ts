import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { VectorError } from "../errors";
import type { Sqlite3Static } from "./types";
import { canonicalNodeSqlitePath, NodeSqliteFiles } from "./node-files";
import { NodeFileOwnership } from "./node-file-ownership";

const VFS_NAME = "node-file";

interface FileEntry {
  pFile: number;
  identifier: number;
  path: string | null;
  flags: number;
  ownership?: NodeFileOwnership;
  lockType: number;
}

/**
 * 処理名: Node.js ホストファイル VFS 登録関数
 * 処理概要: SQLite Wasm インスタンスへ "node-file" VFS を登録し、ホストファイルシステムへの直接 CRUD および排他所有権を提供する。
 * 実装理由: 永続化ストレージとして Node 標準 fs を用い、プロセス間・Worker 間での完全な ACID 耐久性とクラッシュ復旧を保証するため。
 * @param sqlite3 - SQLite3 静的インターフェース。
 * @returns VFS ライフサイクル制御オブジェクト ({ close(): void })。
 */
export function installNodeFileVfs(sqlite3: Sqlite3Static): { close(): void } {
  const wasm = sqlite3.wasm as any;
  const capi = sqlite3.capi as any;
  const files = new NodeSqliteFiles();

  let idCounter = 1;
  const pFileToEntry = new Map<number, FileEntry>();

  const ioMethods = {
    xClose: (pFile: number): number => {
      const entry = pFileToEntry.get(pFile);
      if (!entry) return capi.SQLITE_OK;
      pFileToEntry.delete(pFile);
      try {
        files.close(entry.identifier);
      } catch {
        // 無視
      }
      if (entry.ownership) {
        try {
          entry.ownership.release();
        } catch {
          // 無視
        }
      }
      return capi.SQLITE_OK;
    },

    xRead: (pFile: number, pDest: number, n: number, offset64: number | bigint): number => {
      const entry = pFileToEntry.get(pFile);
      if (!entry) return capi.SQLITE_IOERR;
      const offset = Number(offset64);
      const buf = new Uint8Array(n);
      try {
        const bytesRead = files.read(entry.identifier, buf, offset);
        const heap = wasm.heap8u();
        heap.set(buf, Number(pDest));
        if (bytesRead < n) {
          return capi.SQLITE_IOERR_SHORT_READ;
        }
        return capi.SQLITE_OK;
      } catch {
        return capi.SQLITE_IOERR_READ;
      }
    },

    xWrite: (pFile: number, pSrc: number, n: number, offset64: number | bigint): number => {
      const entry = pFileToEntry.get(pFile);
      if (!entry) return capi.SQLITE_IOERR;
      const offset = Number(offset64);
      try {
        const heap = wasm.heap8u();
        const slice = heap.subarray(Number(pSrc), Number(pSrc) + n);
        files.write(entry.identifier, slice, offset);
        return capi.SQLITE_OK;
      } catch {
        return capi.SQLITE_IOERR_WRITE;
      }
    },

    xTruncate: (pFile: number, size64: number | bigint): number => {
      const entry = pFileToEntry.get(pFile);
      if (!entry) return capi.SQLITE_IOERR;
      const size = Number(size64);
      try {
        files.truncate(entry.identifier, size);
        return capi.SQLITE_OK;
      } catch {
        return capi.SQLITE_IOERR_TRUNCATE;
      }
    },

    xSync: (pFile: number, _flags: number): number => {
      const entry = pFileToEntry.get(pFile);
      if (!entry) return capi.SQLITE_IOERR;
      try {
        files.sync(entry.identifier);
        return capi.SQLITE_OK;
      } catch {
        return capi.SQLITE_IOERR_FSYNC;
      }
    },

    xFileSize: (pFile: number, pSize64: number): number => {
      const entry = pFileToEntry.get(pFile);
      if (!entry) return capi.SQLITE_IOERR;
      try {
        const sz = files.size(entry.identifier);
        wasm.poke(pSize64, sz, "i64");
        return capi.SQLITE_OK;
      } catch {
        return capi.SQLITE_IOERR_FSTAT;
      }
    },

    xLock: (pFile: number, lockType: number): number => {
      const entry = pFileToEntry.get(pFile);
      if (!entry) return capi.SQLITE_IOERR;
      entry.lockType = lockType;
      return capi.SQLITE_OK;
    },

    xUnlock: (pFile: number, lockType: number): number => {
      const entry = pFileToEntry.get(pFile);
      if (!entry) return capi.SQLITE_IOERR;
      entry.lockType = lockType;
      return capi.SQLITE_OK;
    },

    xCheckReservedLock: (pFile: number, pOut: number): number => {
      const entry = pFileToEntry.get(pFile);
      if (!entry) return capi.SQLITE_IOERR;
      wasm.poke32(pOut, entry.lockType > capi.SQLITE_LOCK_SHARED ? 1 : 0);
      return capi.SQLITE_OK;
    },

    xFileControl: (_pFile: number, _op: number, _pArg: number): number => {
      return capi.SQLITE_NOTFOUND;
    },

    xSectorSize: (_pFile: number): number => {
      return 4096;
    },

    xDeviceCharacteristics: (_pFile: number): number => {
      return 0;
    }
  };

  const nodeIoMethods = new capi.sqlite3_io_methods();
  nodeIoMethods.$iVersion = 1;
  (sqlite3 as any).vfs.installVfs({
    io: { struct: nodeIoMethods, methods: ioMethods }
  });

  const vfsMethods = {
    xOpen: (pVfs: number, zName: number, pFile: number, flags: number, pOutFlags: number): number => {
      const filename = zName ? wasm.cstrToJs(zName) : null;
      const isMainDb = (flags & capi.SQLITE_OPEN_MAIN_DB) !== 0;
      const isCreate = (flags & capi.SQLITE_OPEN_CREATE) !== 0;
      const isReadonly = (flags & capi.SQLITE_OPEN_READONLY) !== 0;
      const isDeleteOnClose = (flags & capi.SQLITE_OPEN_DELETEONCLOSE) !== 0;

      let ownership: NodeFileOwnership | undefined;
      if (isMainDb && filename) {
        try {
          const canonical = canonicalNodeSqlitePath(filename);
          ownership = new NodeFileOwnership(canonical);
        } catch (err) {
          if (err instanceof VectorError && err.code === "E_DATABASE_LOCKED") {
            return capi.SQLITE_BUSY;
          }
          return capi.SQLITE_CANTOPEN;
        }
      }

      const identifier = idCounter++;
      try {
        files.open(identifier, filename, {
          create: isCreate,
          readonly: isReadonly,
          main: isMainDb,
          removeOnClose: isDeleteOnClose || filename === null
        });
      } catch (err) {
        ownership?.release();
        if (err instanceof VectorError && err.code === "E_DATABASE_LOCKED") {
          return capi.SQLITE_BUSY;
        }
        return capi.SQLITE_CANTOPEN;
      }

      const sq3File = new capi.sqlite3_file(pFile);
      sq3File.$pMethods = nodeIoMethods.pointer;
      sq3File.dispose();

      pFileToEntry.set(pFile, {
        pFile,
        identifier,
        path: filename,
        flags,
        ownership,
        lockType: capi.SQLITE_LOCK_NONE
      });

      if (pOutFlags) {
        wasm.poke32(pOutFlags, flags);
      }
      return capi.SQLITE_OK;
    },

    xDelete: (_pVfs: number, zName: number, _syncDir: number): number => {
      const filename = wasm.cstrToJs(zName);
      try {
        files.delete(filename);
        return capi.SQLITE_OK;
      } catch {
        return capi.SQLITE_IOERR_DELETE;
      }
    },

    xAccess: (_pVfs: number, zName: number, flags: number, pOut: number): number => {
      const filename = wasm.cstrToJs(zName);
      const writable = (flags & capi.SQLITE_ACCESS_READWRITE) !== 0;
      const ok = files.accessible(filename, writable);
      wasm.poke32(pOut, ok ? 1 : 0);
      return capi.SQLITE_OK;
    },

    xFullPathname: (_pVfs: number, zName: number, nOut: number, pOut: number): number => {
      const filename = wasm.cstrToJs(zName);
      try {
        const canonical = canonicalNodeSqlitePath(filename);
        const encoded = new TextEncoder().encode(canonical);
        if (encoded.length >= nOut) {
          return capi.SQLITE_CANTOPEN;
        }
        const heap = wasm.heap8u();
        heap.set(encoded, Number(pOut));
        heap[Number(pOut) + encoded.length] = 0;
        return capi.SQLITE_OK;
      } catch {
        return capi.SQLITE_CANTOPEN;
      }
    },

    xRandomness: (_pVfs: number, nOut: number, pOut: number): number => {
      const heap = wasm.heap8u();
      const randomBuf = crypto.randomBytes(nOut);
      heap.set(randomBuf, Number(pOut));
      return nOut;
    },

    xSleep: (_pVfs: number, microseconds: number): number => {
      const ms = Math.ceil(microseconds / 1000);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
      return capi.SQLITE_OK;
    },

    xCurrentTime: (_pVfs: number, pOut: number): number => {
      wasm.poke(pOut, 2440587.5 + Date.now() / 86400000, "double");
      return capi.SQLITE_OK;
    },

    xGetLastError: (_pVfs: number, _nOut: number, _pOut: number): number => {
      return 0;
    }
  };

  const nodeVfs = new capi.sqlite3_vfs();
  nodeVfs.$iVersion = 1;
  nodeVfs.$szOsFile = capi.sqlite3_file.structInfo.sizeof;
  nodeVfs.$mxPathname = 1024;
  nodeVfs.addOnDispose(
    (nodeVfs.$zName = wasm.allocCString(VFS_NAME))
  );

  (sqlite3 as any).vfs.installVfs({
    vfs: { struct: nodeVfs, methods: vfsMethods, asDefault: false }
  });

  let isClosed = false;

  return {
    close: (): void => {
      if (isClosed) return;
      isClosed = true;

      for (const entry of Array.from(pFileToEntry.values())) {
        try {
          files.close(entry.identifier);
        } catch {}
        try {
          entry.ownership?.release();
        } catch {}
      }
      pFileToEntry.clear();
      files.dispose();

      try {
        capi.sqlite3_vfs_unregister(nodeVfs);
        nodeVfs.dispose();
        nodeIoMethods.dispose();
      } catch {
        // 無視
      }
    }
  };
}
