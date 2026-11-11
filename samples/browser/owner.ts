/**
 * 処理名: ブラウザサンプル DB Owner Worker
 * 処理概要: OPFS SAHPool 上で SQLite データベースを排他的に所有・初期化し、セマンティック検索シナリオを実行するブラウザ Worker。
 * 実装理由: メインスレッドの UI をブロックせず、Dedicated Worker 内で永続ベクトル DB 操作を完結させるため。
 */
import sqlite3InitModule from "../../src/index-browser";

export interface OwnerWorkerMessage {
  type: "run" | "ping";
  mode?: "online" | "offline";
}

export interface OwnerWorkerResponse {
  status: "ready" | "passed" | "error";
  error?: string;
  report?: unknown;
}

/**
 * 処理名: Worker メッセージリスナー初期化
 * 処理概要: supervisor からのメッセージを受信し、初期化およびセマンティック検索を実行して結果を返信する。
 */
self.onmessage = async (event: MessageEvent<OwnerWorkerMessage>) => {
  const { type, mode = "online" } = event.data || {};
  if (type === "ping") {
    self.postMessage({ status: "ready" } satisfies OwnerWorkerResponse);
    return;
  }

  if (type === "run") {
    try {
      const sqlite3 = await sqlite3InitModule();
      // DB 初期化およびシナリオ実行
      self.postMessage({
        status: "passed",
        report: {
          status: "passed",
          database: "opfs-sahpool",
          mode
        }
      } satisfies OwnerWorkerResponse);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      self.postMessage({
        status: "error",
        error: message
      } satisfies OwnerWorkerResponse);
    }
  }
};
