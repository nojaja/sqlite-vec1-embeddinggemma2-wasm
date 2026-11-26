import { initializeOfficialRuntime } from "./initialize";
import type { ProductInitOptions, ProductSqlite3, Sqlite3Static, OfficialFactory, sqlite3Worker1Promiser } from "./types";
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
    worker: typeof importScripts === "function",
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
