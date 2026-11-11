import { initializeOfficialRuntime } from "./initialize";
import type { ProductInitOptions, ProductSqlite3, Sqlite3Static, OfficialFactory, sqlite3Worker1Promiser } from "./types";
import { resolveOfficialBrowserAssets } from "./browser-inference";

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
 * 処理名: ブラウザ向け公式デフォルトエントリ初期化関数
 * 処理概要: ブラウザ環境向けに SQLite3 を初期化し、埋め込み拡張と SAH pool を結合する。
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
    env
  );
}

export { resolveOfficialBrowserAssets };
