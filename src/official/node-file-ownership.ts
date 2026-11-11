import * as crypto from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import { VectorError } from "../errors";

/**
 * 処理名: パイプパス生成
 * 処理概要: 正規化パスの SHA-256 ハッシュを元にプラットフォーム固有の排他用名前空間パスを生成する。
 * 実装理由: Windows では Named Pipe、UNIX ではソケットファイルを用いて OS カーネルによる安全な排他を実現するため。
 * @param canonicalPath - 正規化された絶対パス。
 * @returns プラットフォーム固有のパイプまたはソケットパス。
 */
export function getOwnershipPipePath(canonicalPath: string): string {
  const norm = process.platform === "win32" ? canonicalPath.toLowerCase() : canonicalPath;
  const hash = crypto.createHash("sha256").update(norm).digest("hex");
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\svw-sqlite-${hash}`;
  }
  return path.join(os.tmpdir(), `svw-sqlite-${hash}.sock`);
}

const HELPER_WORKER_CODE = `
const { workerData, parentPort } = require("node:worker_threads");
const net = require("node:net");
const fs = require("node:fs");

const { pipePath, sab } = workerData;
const int32 = new Int32Array(sab);

const server = net.createServer();

server.once("error", (err) => {
  if (err.code === "EADDRINUSE") {
    Atomics.store(int32, 0, 2);
  } else {
    Atomics.store(int32, 0, 3);
  }
  Atomics.notify(int32, 0);
});

server.listen(pipePath, () => {
  Atomics.store(int32, 0, 1);
  Atomics.notify(int32, 0);
});

if (parentPort) {
  parentPort.on("message", (msg) => {
    if (msg && msg.kind === "release") {
      server.close(() => {
        if (process.platform !== "win32") {
          try { fs.unlinkSync(pipePath); } catch {}
        }
        Atomics.store(int32, 0, 4);
        Atomics.notify(int32, 0);
      });
    }
  });
}
`;

/**
 * 処理名: NodeFileOwnership クラス
 * 処理概要: OS カーネルのリスナー排他を用いてデータベースファイルの排他所有権を確立・解放する。
 * 実装理由: 同一プロセス・他プロセス・クラッシュ時の確実なファイル排他を保証するため。
 */
export class NodeFileOwnership {
  private readonly pipePath: string;
  private readonly worker: Worker;
  private readonly sab: SharedArrayBuffer;
  private readonly int32: Int32Array;
  private released = false;

  /**
   * 処理名: NodeFileOwnership コンストラクタ
   * 処理概要: ヘルパー Worker を起動し、最大 10000ms で排他リスナーの取得を待機する。
   * @param canonicalPath - 排他対象ファイルの正規化絶対パス。
   */
  constructor(canonicalPath: string) {
    this.pipePath = getOwnershipPipePath(canonicalPath);
    this.sab = new SharedArrayBuffer(4);
    this.int32 = new Int32Array(this.sab);

    try {
      this.worker = new Worker(HELPER_WORKER_CODE, {
        eval: true,
        execArgv: [],
        workerData: {
          pipePath: this.pipePath,
          sab: this.sab
        }
      });
    } catch {
      throw new VectorError("E_STORAGE");
    }

    const waitRes = Atomics.wait(this.int32, 0, 0, 10000);
    const status = Atomics.load(this.int32, 0);

    if (waitRes === "timed-out" || status === 0) {
      this.worker.terminate();
      throw new VectorError("E_STORAGE");
    }
    if (status === 2) {
      this.worker.terminate();
      throw new VectorError("E_DATABASE_LOCKED");
    }
    if (status !== 1) {
      this.worker.terminate();
      throw new VectorError("E_STORAGE");
    }
  }

  /**
   * 処理名: 排他所有権解放
   * 処理概要: ヘルパー Worker へ終了を通知し、リスナーのクローズを最大 10000ms 待機して Worker を終了する。
   * 実装理由: 正常クローズ時にカーネル資源を即座に解放し、後続接続を可能にするため。
   */
  public release(): void {
    if (this.released) return;
    this.released = true;

    try {
      this.worker.postMessage({ kind: "release" });
      const waitRes = Atomics.wait(this.int32, 0, 1, 10000);
      const status = Atomics.load(this.int32, 0);
      if (waitRes === "timed-out" || status !== 4) {
        this.worker.terminate();
        throw new VectorError("E_STORAGE");
      }
    } finally {
      this.worker.terminate();
    }
  }
}
