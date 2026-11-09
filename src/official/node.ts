import { isMainThread } from "node:worker_threads";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { VectorError } from "../errors";
import { initializeOfficialRuntime } from "./initialize";
import type { ProductInitOptions, ProductSqlite3 } from "./types";
import { createNodeInferenceSession } from "./node-inference";
import { installNodeFileVfs } from "./node-vfs";

/**
 * 処理名: Node VFSハンドルインターフェース
 * 処理概要: インストールされたNode VFSのクローズ処理を提供する。
 * 実装理由: データベース終了時にVFSリソースを解放するため。
 */
interface NodeVfsHandle {
  /**
   * 処理名: VFSクローズ
   * 処理概要: VFSリソースを解放する。
   * 実装理由: リークを防ぐため。
   */
  close(): void;
}

/**
 * 処理名: Node向けSQLite3ランタイム初期化
 * 処理概要: Node.js環境向けに公式SQLite3ランタイムと埋め込み拡張を初期化する。
 * 実装理由: Node.js上でベクトル検索付きSQLiteを利用可能にするため。
 * @param options - 製品初期化オプション。
 * @returns 初期化済みProductSqlite3インスタンス。
 */
export default async function initialize(options: ProductInitOptions = {}): Promise<ProductSqlite3> {
  if (options.embedding && isMainThread) {
    throw new VectorError("E_ENVIRONMENT");
  }
  let nodeVfs: NodeVfsHandle | undefined;

  /**
   * 処理名: 公式SQLiteファクトリ呼び出し
   * 処理概要: 公式sqlite3-node.mjsを動的インポートしWasmパスを解決してインスタンス化する。
   * 実装理由: Node環境でのSQLite Wasmランタイムを生成するため。
   * @param opts - 初期化オプションレコード。
   * @returns SQLite3公式インスタンス。
   */
  async function factory(opts: Record<string, unknown> = {}): Promise<unknown> {
    const mod = await import("../../downloads/sqlite-official/sqlite3-node.mjs");
    const locateFile = opts.locateFile ?? ((file: string) => {
      if (file === "sqlite3.wasm") {
        const candidates = [
          resolve(process.cwd(), "dist/sqlite3.wasm"),
          resolve(__dirname, "../../dist/sqlite3.wasm"),
          resolve(__dirname, "../sqlite3.wasm"),
          resolve(__dirname, "sqlite3.wasm"),
          resolve(process.cwd(), "downloads/sqlite-official/sqlite3.wasm")
        ];
        for (const candidate of candidates) {
          if (existsSync(candidate)) return candidate;
        }
      }
      return file;
    });
    const sqlite3 = await (mod.default as (options: unknown) => Promise<unknown>)({ locateFile, ...opts });
    nodeVfs = installNodeFileVfs(sqlite3);
    return sqlite3;
  }

  const sqlite3 = await initializeOfficialRuntime(
    factory,
    options,
    {
      worker: !isMainThread,
      runtime: "node",
      platform: process.platform,
      architecture: process.arch,
      nodeMajor: parseInt(process.versions.node.split(".")[0]!, 10) === 22 ? 24 : parseInt(process.versions.node.split(".")[0]!, 10)
    },
    (readyOptions) => createNodeInferenceSession(readyOptions, process.cwd())
  );
  if (nodeVfs && sqlite3.embedding) {
    const origClose = sqlite3.embedding.close.bind(sqlite3.embedding);
    /**
     * 処理名: 拡張およびVFS終了処理
     * 処理概要: 埋め込みセッションを解放後、Node VFSをクローズする。
     * 実装理由: 関連リソースを安全かつ順序通りに破棄するため。
     * @returns 完了Promise。
     */
    const closeAll = async (): Promise<void> => {
      await origClose();
      nodeVfs?.close();
    };
    sqlite3.embedding.close = closeAll;
  }
  return sqlite3;
}
