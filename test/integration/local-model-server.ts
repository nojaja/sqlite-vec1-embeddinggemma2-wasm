import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { MODEL_ASSET_FILES, MODEL_REVISION } from "../../src/runtime-assets/model-contract";

/**
 * 処理名: local model server
 * 処理概要: 配置済み固定revisionのallowlist資材だけをloopback HTTPで配信する。
 * 実装理由: integration testで外部networkや任意pathを使わずonline cache取得を実行するため。
 */
export interface LocalModelServer {
  /** 処理名: model base URL。処理概要: 公開APIへ渡すloopback root。実装理由: port自動割当を利用者から隠すため。 */
  baseUrl: string;
  /** 処理名: server終了。処理概要: listenerを閉じる。実装理由: test後にsocketを残さないため。 @returns 終了完了。 */
  close(): Promise<void>;
}

/**
 * 処理名: local model server起動
 * 処理概要: 固定11資材だけをrevision directoryから配信する。
 * 実装理由: G04/G06の実model gateを承認済みlocal bytesで再現するため。
 * @returns 起動済みserver。
 */
export async function startLocalModelServer(): Promise<LocalModelServer> {
  const root = resolve("model", "embeddinggemma-2-ONNX", MODEL_REVISION);
  const files = new Map(MODEL_ASSET_FILES.map((asset) => [`/${asset.path}`, { filename: resolve(root, asset.source), mime: asset.mime }]));
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const asset = files.get(path);
    if (request.method !== "GET" || asset === undefined) { response.writeHead(404).end(); return; }
    void readFile(asset.filename).then((bytes) => {
      response.writeHead(200, { "Content-Type": asset.mime, "Content-Length": String(bytes.length), "Cache-Control": "no-store" });
      response.end(bytes);
    }).catch(() => response.writeHead(500).end());
  });
  /**
   * 処理名: listen開始
   * 処理概要: serverの開始結果をPromiseへ接続する。
   * 実装理由: port確定まで待つため。
   * @param resolveListen - 成功完了。
   * @param rejectListen - 起動失敗。
   */
  function listen(resolveListen: () => void, rejectListen: (reason?: unknown) => void): void {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  }
  await new Promise<void>(listen);
  const address = server.address();
  if (address === null || typeof address === "string") { await closeServer(server); throw new Error("LOCAL_MODEL_SERVER_ADDRESS"); }
  let closed = false;
  /**
   * 処理名: local server終了
   * 処理概要: 所有serverを閉じる。
   * 実装理由: test cleanupを単一操作にするため。
   * @returns 終了完了。
   */
  async function close(): Promise<void> { if (closed) return; closed = true; await closeServer(server); }
  return { baseUrl: `http://127.0.0.1:${address.port}/`, close };
}

/**
 * 処理名: HTTP server終了
 * 処理概要: close callbackをPromiseへ変換する。
 * 実装理由: test cleanupを完了まで待つため。
 * @param server - 終了対象。
 * @returns 終了完了。
 */
async function closeServer(server: Server): Promise<void> {
  /**
   * 処理名: close開始
   * 処理概要: server callbackをPromiseへ接続する。
   * 実装理由: close失敗を呼出し側へ返すため。
   * @param resolveClose - 正常完了。
   * @param rejectClose - 終了失敗。
   */
  function closeOperation(resolveClose: () => void, rejectClose: (reason?: unknown) => void): void {
    /**
     * 処理名: close結果
     * 処理概要: callback結果でPromiseを完了する。
     * 実装理由: errorを無視しないため。
     * @param error - 終了error。
     */
    function complete(error?: Error): void { if (error === undefined) resolveClose(); else rejectClose(error); }
    server.close(complete);
  }
  await new Promise<void>(closeOperation);
}
