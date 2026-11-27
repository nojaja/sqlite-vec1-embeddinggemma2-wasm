import { VectorError } from "../errors";
import { initializeOfficialRuntime } from "./initialize";
import type {
  ProductInitOptions,
  ProductSqlite3,
  OfficialFactory,
  sqlite3Worker1Promiser,
  EmbeddingWorkerPromiserConfig,
  EmbeddingWorkerPromiserResponse,
  EmbeddingWorkerPromiser
} from "./types";
import { createBrowserInferenceSession, resolveOfficialBrowserAssets } from "./browser-inference";

/**
 * 処理名: ブラウザ向け公式ファクトリラッパー
 */
const browserOfficialFactory: OfficialFactory = async (options = {}) => {
  // ブラウザ環境では sqlite3-bundler-friendly.mjs またはグローバル sqlite3InitModule を使用
  const loader = (await import("../../downloads/sqlite-official/sqlite3-bundler-friendly.mjs")).default;
  return (loader as unknown as OfficialFactory)(options);
};

/**
 * 処理名: ブラウザ向け公式 worker1 promiser
 * 処理概要: 公式 sqlite3-worker1-promiser.mjs をラップして返す。
 */
export const sqlite3Worker1Promiser: sqlite3Worker1Promiser = (options?: unknown) => {
  return async (...args: unknown[]) => {
    const promiserModule = (await import("../../downloads/sqlite-official/sqlite3-worker1-promiser.mjs")).default;
    const p = (promiserModule as unknown as sqlite3Worker1Promiser)(options);
    return p(...args);
  };
};

/**
 * 処理名: ブラウザエントリ URL 解決
 * 処理概要: 現在の実行コンテキストからブラウザエントリ基準の URL を取得する。
 * 実装理由: バンドラーや実行コンテキストを問わず資材 URL 解決の起点を決定するため。
 * @returns エントリ基準 URL 文字列。
 */
function resolveBrowserEntryUrl(): string {
  if (typeof globalThis.location?.href === "string") {
    return globalThis.location.href;
  }
  return "https://localhost/dist/index-browser.mjs";
}

/**
 * 処理名: Dedicated Worker コンテキスト判定
 * 処理概要: 現在のブラウザ実行環境が Dedicated Worker 内であるかを ESM Worker を含めて判定する。
 * 実装理由: window メインスレッドでの Atomics.wait 不可による実行時エラーを初期化時点で早期検知するため。
 * @returns Dedicated Worker 内の場合は true。
 */
function isBrowserDedicatedWorker(): boolean {
  const hasWindow = typeof (globalThis as { window?: unknown }).window !== "undefined";
  if (hasWindow) {
    return false;
  }
  if (typeof importScripts === "function") {
    return true;
  }
  return typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== "undefined";
}

/**
 * 処理名: DB Worker 初期化完了待機
 * 処理概要: Dedicated DB Worker からの ready/failed 通知または起動エラーを待機する。
 * 実装理由: 推論セッションと SQLite の準備が完了してから Promiser を利用可能にするため。
 * @param worker - 起動済み Web Worker。
 * @returns 準備完了時に解決する Promise。
 */
function awaitDbWorkerReady(worker: Worker): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    /**
     * 処理名: 待機リスナー解除
     * 処理概要: 初期化待機用の message/error リスナーを解除する。
     * 実装理由: 初期化完了後のリスナーリークを防ぐため。
     */
    const cleanup = () => {
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
    };

    /**
     * 処理名: 初期化応答ハンドラ
     * 処理概要: ready または failed メッセージを判定する。
     * 実装理由: 初期化成否を Promiser 生成元へ伝播するため。
     * @param event - MessageEvent。
     */
    const onMessage = (event: MessageEvent<unknown>) => {
      const data = event.data as { kind?: string; error?: string } | undefined;
      if (data?.kind === "ready") {
        cleanup();
        resolve();
      } else if (data?.kind === "failed") {
        cleanup();
        worker.terminate();
        reject(new Error(data.error ?? "E_INFERENCE"));
      }
    };

    /**
     * 処理名: 初期化エラーハンドラ
     * 処理概要: Worker 起動エラー時に Worker を終了して reject する。
     * 実装理由: 未処理エラーによるハングを防ぐため。
     */
    const onError = () => {
      cleanup();
      worker.terminate();
      reject(new VectorError("E_INFERENCE"));
    };

    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
  });
}

/**
 * 処理名: ブラウザメインスレッド向け埋め込み対応 Promiser 生成
 * 処理概要: Dedicated DB Worker を起動し、メインスレッドから非同期 RPC で embedding UDF を実行できる Promiser 関数を返す。
 * 実装理由: ブラウザメインスレッドでの Atomics.wait 禁止制約を回避し、既存の非同期アプリから安全に推論付き SQL を実行するため。
 * @param config - Promiser 設定。
 * @returns RPC 実行用 Promiser 関数。
 */
export async function sqlite3EmbeddingWorkerPromiser(
  config: EmbeddingWorkerPromiserConfig = {}
): Promise<EmbeddingWorkerPromiser> {
  if (typeof Worker === "undefined") {
    throw new VectorError("E_ENVIRONMENT");
  }

  const assets = resolveOfficialBrowserAssets(resolveBrowserEntryUrl(), {
    dbWorkerUrl: config.dbWorkerUrl
  });
  const worker = new Worker(assets.dbWorker, { type: "module" });
  const readyPromise = awaitDbWorkerReady(worker);

  worker.postMessage({
    kind: "initialize",
    embedding: config.embedding
  });

  try {
    await readyPromise;
    config.onready?.();
  } catch (err: unknown) {
    config.onerror?.(err);
    throw err;
  }

  let messageCounter = 1;
  const pending = new Map<
    string,
    { resolve: (res: EmbeddingWorkerPromiserResponse) => void; reject: (err: Error) => void }
  >();

  worker.addEventListener("message", (event: MessageEvent<unknown>) => {
    const data = event.data as {
      type?: string;
      messageId?: string;
      result?: Record<string, unknown>;
      error?: string;
    } | undefined;
    if (!data?.messageId) {
      return;
    }
    const entry = pending.get(data.messageId);
    if (!entry) {
      return;
    }
    pending.delete(data.messageId);
    if (typeof data.error === "string") {
      entry.reject(new Error(data.error));
      return;
    }
    entry.resolve({
      type: data.type ?? "",
      messageId: data.messageId,
      result: data.result ?? {}
    });
  });

  return (type: string, args?: Record<string, unknown>): Promise<EmbeddingWorkerPromiserResponse> => {
    const messageId = `msg-${messageCounter++}`;
    return new Promise<EmbeddingWorkerPromiserResponse>((resolve, reject) => {
      pending.set(messageId, { resolve, reject });
      worker.postMessage({ type, messageId, args });
    }).finally(() => {
      if (type === "shutdown") {
        worker.terminate();
      }
    });
  };
}

/**
 * 処理名: ブラウザ向け公式デフォルトエントリ初期化関数
 * 処理概要: ブラウザ環境向けに SQLite3 を初期化し、埋め込み拡張と SAH pool、ブラウザ推論セッションを結合する。
 * 実装理由: ブラウザ単体でオンデマンド CDN 取得・OPFS キャッシュ・ベクトル推論を完結させるため。
 * @param options - 初期化オプション。
 * @returns 初期化完了した ProductSqlite3。
 */
export default async function initialize(
  options: ProductInitOptions = {}
): Promise<ProductSqlite3> {
  const env = {
    worker: isBrowserDedicatedWorker(),
    runtime: "browser" as const,
    platform: "browser",
    architecture: "browser"
  };

  return initializeOfficialRuntime(
    browserOfficialFactory,
    options,
    env,
    (validated) => createBrowserInferenceSession(validated, resolveBrowserEntryUrl())
  );
}

export { resolveOfficialBrowserAssets };
