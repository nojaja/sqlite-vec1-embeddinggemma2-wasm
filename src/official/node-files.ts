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

export interface NodeSqliteFileOptions {
  create: boolean;
  readonly: boolean;
  main: boolean;
  removeOnClose: boolean;
}

interface OpenFileEntry {
  fd: number;
  filename: string;
  isTemp: boolean;
  removeOnClose: boolean;
  lockServer?: Server | undefined;
}

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

export class NodeSqliteFiles {
  private readonly entries = new Map<number, OpenFileEntry>();
  private readonly locks = new Map<string, Server>();

  public open(
    identifier: number,
    filename: string | null,
    options: NodeSqliteFileOptions
  ): void {
    if (this.entries.has(identifier)) {
      throw new VectorError("E_STORAGE");
    }

    let targetPath = filename;
    let isTemp = false;
    let lockServer: Server | undefined;

    if (targetPath === null) {
      isTemp = true;
      const rnd = Math.random().toString(36).slice(2);
      targetPath = join(tmpdir(), `sqlite-temp-${process.pid}-${rnd}.tmp`);
    } else {
      if (targetPath.includes("\0")) throw new VectorError("E_STORAGE");
      targetPath = canonicalNodeSqlitePath(targetPath);
      try {
        const stat = lstatSync(targetPath, { throwIfNoEntry: false });
        if (stat && stat.isSymbolicLink()) {
          throw new VectorError("E_STORAGE");
        }
      } catch (err) {
        if (err instanceof VectorError) throw err;
      }

      if (options.main) {
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
        } catch (e: any) {
          if (e?.code === "EADDRINUSE") {
            throw new VectorError("E_DATABASE_LOCKED");
          }
          throw new VectorError("E_STORAGE");
        }
        server.on("error", () => {});
        this.locks.set(pipeName, server);
        lockServer = server;
      }
    }

    let flags = 0;
    if (options.readonly) {
      flags |= constants.O_RDONLY;
    } else if (options.create) {
      flags |= constants.O_RDWR | constants.O_CREAT;
    } else {
      flags |= constants.O_RDWR;
    }

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
    } catch (err) {
      if (lockServer) {
        lockServer.close();
        for (const [k, v] of this.locks.entries()) {
          if (v === lockServer) this.locks.delete(k);
        }
      }
      throw new VectorError("E_STORAGE");
    }
  }

  private getEntry(identifier: number): OpenFileEntry {
    const entry = this.entries.get(identifier);
    if (!entry) throw new VectorError("E_STORAGE");
    return entry;
  }

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

  public sync(identifier: number): void {
    const entry = this.getEntry(identifier);
    try {
      fsyncSync(entry.fd);
    } catch {
      throw new VectorError("E_STORAGE");
    }
  }

  public truncate(identifier: number, size: number): void {
    const entry = this.getEntry(identifier);
    try {
      ftruncateSync(entry.fd, size);
    } catch {
      throw new VectorError("E_STORAGE");
    }
  }

  public size(identifier: number): number {
    const entry = this.getEntry(identifier);
    try {
      return fstatSync(entry.fd).size;
    } catch {
      throw new VectorError("E_STORAGE");
    }
  }

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

  public delete(filename: string, _synchronize?: boolean): void {
    try {
      unlinkSync(filename);
    } catch {
      throw new VectorError("E_STORAGE");
    }
  }

  public close(identifier: number): void {
    const entry = this.entries.get(identifier);
    if (!entry) throw new VectorError("E_STORAGE");
    this.entries.delete(identifier);
    try {
      closeSync(entry.fd);
    } catch {
      // ignore
    } finally {
      if (entry.lockServer) {
        entry.lockServer.close();
        for (const [k, v] of this.locks.entries()) {
          if (v === entry.lockServer) this.locks.delete(k);
        }
      }
      if (entry.removeOnClose) {
        try { unlinkSync(entry.filename); } catch {}
      }
    }
  }

  public dispose(): void {
    for (const identifier of Array.from(this.entries.keys())) {
      this.close(identifier);
    }
  }
}
