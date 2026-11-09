import { initializeOfficialRuntime } from "./initialize";
import type { ProductInitOptions, ProductSqlite3 } from "./types";
import { MODEL_ID, MODEL_REVISION } from "../runtime-assets/model-contract";

/**
 * 処理名: 公式Worker1プロミサー初期化
 * 処理概要: sqlite3-worker1-promiser.mjsを動的インポートしプロミサー関数を生成する。
 * 実装理由: Web Workerベースの非同期プロミサーAPIをブラウザで利用可能にするため。
 * @param args - プロミサー生成引数。
 * @returns プロミサー関数インスタンス。
 */
export async function sqlite3Worker1Promiser(...args: unknown[]): Promise<unknown> {
  const mod = await import("../../downloads/sqlite-official/sqlite3-worker1-promiser.mjs");
  const defaultFn = (mod as { default: (...a: unknown[]) => unknown }).default;
  return defaultFn(...args);
}

/**
 * 処理名: ブラウザ向けSQLite3ランタイム初期化
 * 処理概要: ブラウザ環境向けに公式SQLite3ランタイムと埋め込み拡張を初期化する。
 * 実装理由: ブラウザ上でベクトル検索付きSQLiteを利用可能にするため。
 * @param options - 製品初期化オプション。
 * @returns 初期化済みProductSqlite3インスタンス。
 */
export default async function initialize(options: ProductInitOptions = {}): Promise<ProductSqlite3> {
  const globalObj = globalThis as unknown as Record<string, unknown>;
  const selfObj = typeof self !== "undefined" ? (self as unknown as Record<string, unknown>) : {};
  const isDedicatedWorker = typeof globalObj.WorkerGlobalScope !== "undefined" && typeof selfObj.importScripts === "function";

  /**
   * 処理名: ブラウザ公式SQLiteファクトリ呼び出し
   * 処理概要: sqlite3-bundler-friendly.mjsを動的インポートしインスタンス化する。
   * 実装理由: ブラウザ環境でのSQLite Wasmランタイムを生成するため。
   * @param opts - 初期化オプションレコード。
   * @returns SQLite3公式インスタンス。
   */
  async function factory(opts?: Record<string, unknown>): Promise<unknown> {
    const mod = await import("../../downloads/sqlite-official/sqlite3-bundler-friendly.mjs");
    const defaultFn = (mod as { default: (o?: unknown) => Promise<unknown> }).default;
    return defaultFn(opts);
  }

  /**
   * 処理名: スタブ推論実行
   * 処理概要: 3072バイトのゼロ埋めベクトルを返す。
   * 実装理由: 初期化時のスタブ推論関数を提供するため。
   * @returns 3072バイトのゼロ配列。
   */
  const inferStub = (): Uint8Array => new Uint8Array(3072);

  /**
   * 処理名: スタブ推論セッション終了
   * 処理概要: 何も行わず正常完了する。
   * 実装理由: セッション終了インターフェースを満たすため。
   * @returns 完了Promise。
   */
  const closeStub = async (): Promise<void> => {};

  return initializeOfficialRuntime(
    factory,
    options,
    {
      worker: isDedicatedWorker,
      runtime: "browser",
      platform: "browser",
      architecture: "browser"
    },
    async (readyOptions) => ({
      infer: inferStub,
      identity: {
        modelId: MODEL_ID,
        revision: MODEL_REVISION,
        fingerprint: "5e730f96377d880c7ca94c9ddc9cd5f600e5237e106f5e4dc7d9448140026ac7",
        profile: "embeddinggemma-2/q4/768",
        backend: readyOptions.backend,
        runtimeGeneration: 1
      },
      information: { ready: true },
      close: closeStub
    })
  );
}
