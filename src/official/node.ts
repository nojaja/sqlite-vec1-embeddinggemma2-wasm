import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { initializeOfficialRuntime } from "./initialize";
import { createNodeInferenceSession } from "./node-inference";
import { installNodeFileVfs } from "./node-vfs";
import type { OfficialFactory, ProductInitOptions, ProductSqlite3, Sqlite3Static } from "./types";

function findPackageRoot(startDir: string): string {
  let cur = path.resolve(startDir);
  while (cur !== path.dirname(cur)) {
    if (fs.existsSync(path.join(cur, "package.json"))) {
      return cur;
    }
    cur = path.dirname(cur);
  }
  return path.resolve(startDir, "../..");
}

const packageRoot = findPackageRoot(__dirname);

/**
 * 処理名: SQLite WASM ファイル解決関数
 * 処理概要: sqlite3.wasm の配置場所を packageRoot/dist またはカレントディレクトリから解決する。
 * @param file - 要求ファイル名。
 * @returns 解決されたファイルパスまたは元のファイル名。
 */
export function locateSqliteWasm(file: string): string {
  if (file === "sqlite3.wasm") {
    const distPath = path.resolve(packageRoot, "dist/sqlite3.wasm");
    if (fs.existsSync(distPath)) {
      return distPath;
    }
    const downloadsPath = path.resolve(packageRoot, "downloads/sqlite-official/sqlite3.wasm");
    if (fs.existsSync(downloadsPath)) {
      return downloadsPath;
    }
  }
  return file;
}

/**
 * 処理名: Node 向け公式ファクトリラッパー
 * 処理概要: 公式 sqlite3-node.mjs を動的ロードしてファクトリ関数を生成する。
 */
const nodeOfficialFactory: OfficialFactory = async (options = {}) => {
  const customLocate = options.locateFile ?? locateSqliteWasm;
  const loaderPath = path.resolve(packageRoot, "dist/sqlite3-node.mjs");

  const targetPath = fs.existsSync(loaderPath)
    ? loaderPath
    : path.resolve(packageRoot, "downloads/sqlite-official/sqlite3-node.mjs");
  const targetUrl = pathToFileURL(targetPath).href;
  const initFn = (await import(targetUrl)).default;

  const mergedOpts = {
    locateFile: customLocate,
    ...options
  };

  return initFn(mergedOpts);
};

/**
 * 処理名: Node 向け公式デフォルトエントリ初期化関数
 * 処理概要: 公式 SQLite3 インターフェースを Node.js 環境向けに初期化し、ベクトル埋め込み拡張と結合する。
 * 実装理由: Node ユーザーにゼロ設定の drop-in 互換初期化エントリを提供するため。
 * @param options - 初期化オプション。
 * @returns 初期化完了した ProductSqlite3。
 */
export default async function initialize(
  options?: ProductInitOptions
): Promise<ProductSqlite3> {
  const environment = {
    worker: false,
    runtime: "node" as const,
    platform: process.platform,
    architecture: process.arch,
    nodeMajor: parseInt(process.versions.node.split(".")[0] || "24", 10)
  };

  const sqlite3 = await initializeOfficialRuntime(
    nodeOfficialFactory,
    options,
    environment,
    (opt) => createNodeInferenceSession(opt, packageRoot)
  );

  if (sqlite3.capi) {
    const vfsControl = installNodeFileVfs(sqlite3);
    const origClose = sqlite3.embedding.close.bind(sqlite3.embedding);
    sqlite3.embedding.close = async () => {
      try {
        await origClose();
      } finally {
        vfsControl.close();
      }
    };
  }

  return sqlite3;
}
