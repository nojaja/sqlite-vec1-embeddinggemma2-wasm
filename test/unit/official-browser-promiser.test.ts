jest.mock("../../downloads/sqlite-official/sqlite3-bundler-friendly.mjs", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("../../downloads/sqlite-official/sqlite3-worker1-promiser.mjs", () => ({ __esModule: true, default: jest.fn() }));

import * as browserEntry from "../../src/index-browser";

/**
 * 処理名: モック Worker メッセージイベント型
 * 処理概要: テスト用 Worker が配信するメッセージイベントを表す。
 * 実装理由: ブラウザ Worker 間の message イベントを型安全に模擬するため。
 */
interface MockWorkerMessageEvent {
  data: unknown;
}

/**
 * 処理名: モックブラウザ DB Worker クラス
 * 処理概要: Dedicated Worker のライフサイクルと RPC 応答をインメモリで模擬する。
 * 実装理由: ブラウザ実環境なしで sqlite3EmbeddingWorkerPromiser の RPC 契約を検証するため。
 */
class MockBrowserDbWorker {
  static instances: MockBrowserDbWorker[] = [];
  readonly url: string | URL;
  readonly options?: WorkerOptions | undefined;
  readonly posted: unknown[] = [];
  terminated = false;
  private listeners = new Map<string, Set<(event: MockWorkerMessageEvent) => void>>();

  /**
   * 処理名: モックブラウザDB Workerコンストラクタ
   * 処理概要: 生成されたWorkerのURLとオプションを記録し、インスタンス一覧へ追加する。
   * 実装理由: Promiserが適切なWorker URLとmoduleオプションで起動することを検証するため。
   * @param url - WorkerスクリプトURL。
   * @param options - Worker起動オプション。
   */
  constructor(url: string | URL, options?: WorkerOptions) {
    this.url = url;
    this.options = options;
    MockBrowserDbWorker.instances.push(this);
  }

  /**
   * 処理名: イベントリスナー登録
   * 処理概要: message / error イベントリスナーを登録する。
   * 実装理由: Promiserからの応答待機イベントをテスト内で発火させるため。
   * @param type - イベント種別。
   * @param listener - コールバック関数。
   */
  addEventListener(type: string, listener: (event: MockWorkerMessageEvent) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  /**
   * 処理名: イベントリスナー解除
   * 処理概要: 登録済みのイベントリスナーを解除する。
   * 実装理由: Promiserのクリーンアップ動作を再現するため。
   * @param type - イベント種別。
   * @param listener - コールバック関数。
   */
  removeEventListener(type: string, listener: (event: MockWorkerMessageEvent) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  /**
   * 処理名: メッセージ送信モック
   * 処理概要: 送信メッセージを記憶し、テスト用の自動応答（ready / RPC結果 / shutdown）を返す。
   * 実装理由: メインスレッドとDB Owner Worker間の非同期RPCプロトコルを単体検証するため。
   * @param message - 送信ペイロード。
   */
  postMessage(message: unknown): void {
    this.posted.push(message);
    const payload = message as { kind?: string; type?: string; messageId?: string; args?: Record<string, unknown> };
    queueMicrotask(() => {
      if (payload.kind === "initialize") {
        this.emit("message", { data: { kind: "ready" } });
        return;
      }
      if (payload.type === "open") {
        this.emit("message", {
          data: { type: "open", messageId: payload.messageId, result: { dbId: "db-1" } }
        });
        return;
      }
      if (payload.type === "exec") {
        this.emit("message", {
          data: {
            type: "exec",
            messageId: payload.messageId,
            result: { resultRows: [[1, "hello"]] }
          }
        });
        return;
      }
      if (payload.type === "embedding-info") {
        this.emit("message", {
          data: {
            type: "embedding-info",
            messageId: payload.messageId,
            result: { ready: true, modelId: "google/embeddinggemma-2" }
          }
        });
        return;
      }
      if (payload.type === "close" || payload.type === "shutdown") {
        this.emit("message", {
          data: { type: payload.type, messageId: payload.messageId, result: { ok: true } }
        });
      }
    });
  }

  /**
   * 処理名: Worker終了モック
   * 処理概要: 終了フラグを立てる。
   * 実装理由: shutdown時のリソース解放を検証するため。
   */
  terminate(): void {
    this.terminated = true;
  }

  /**
   * 処理名: モックイベント発火
   * 処理概要: 登録済みリスナーへイベントを配信する。
   * 実装理由: Workerからの非同期応答をシミュレートするため。
   * @param type - イベント種別。
   * @param event - イベントデータ。
   */
  emit(type: string, event: MockWorkerMessageEvent): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

test("official browser promiser: initializes Dedicated DB Worker and executes open/exec/embedding-info/close/shutdown RPC", async () => {
  const originalWorker = (globalThis as { Worker?: unknown }).Worker;
  MockBrowserDbWorker.instances = [];
  (globalThis as { Worker: unknown }).Worker = MockBrowserDbWorker;

  try {
    const promiserFactory = (browserEntry as Record<string, unknown>).sqlite3EmbeddingWorkerPromiser as
      | ((config?: Record<string, unknown>) => Promise<(type: string, args?: Record<string, unknown>) => Promise<{ type: string; result: Record<string, unknown> }>>)
      | undefined;

    expect(typeof promiserFactory).toBe("function");
    const promiser = await promiserFactory!({
      embedding: { model: { network: "allow" } },
      dbWorkerUrl: "https://example.test/dist/workers/db-browser.mjs"
    });

    expect(MockBrowserDbWorker.instances).toHaveLength(1);
    const worker = MockBrowserDbWorker.instances[0]!;
    expect(String(worker.url)).toBe("https://example.test/dist/workers/db-browser.mjs");
    expect(worker.options).toEqual({ type: "module" });
    expect(worker.posted[0]).toMatchObject({
      kind: "initialize",
      embedding: { model: { network: "allow" } }
    });

    const openRes = await promiser("open", { filename: ":memory:" });
    expect(openRes.result).toMatchObject({ dbId: "db-1" });

    const execRes = await promiser("exec", {
      sql: "SELECT 1, embedding('hello')",
      rowMode: "array",
      resultRows: []
    });
    expect(execRes.result).toMatchObject({ resultRows: [[1, "hello"]] });

    const infoRes = await promiser("embedding-info");
    expect(infoRes.result).toMatchObject({ ready: true });

    await promiser("close", {});
    await promiser("shutdown", {});
    expect(worker.terminated).toBe(true);
  } finally {
    if (originalWorker === undefined) {
      delete (globalThis as { Worker?: unknown }).Worker;
    } else {
      (globalThis as { Worker: unknown }).Worker = originalWorker;
    }
  }
});
