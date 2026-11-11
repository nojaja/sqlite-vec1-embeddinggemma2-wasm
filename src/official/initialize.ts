import { VectorError } from "../errors";
import type {
  OfficialFactory,
  ProductInitOptions,
  ProductSqlite3,
  OfficialInferenceSession,
  Sqlite3Static
} from "./types";
import {
  validateEmbeddingOptions,
  type EnvironmentInfo,
  type ValidatedEmbeddingOptions
} from "./options";
import { registerEmbeddingExtension } from "./registration";

/**
 * 処理名: 公式ランタイム初期化関数
 * 処理概要: 公式 SQLite Wasm ファクトリを起動し、推論セッション準備、埋め込み拡張登録、SAH pool ライフサイクル管理を統合した ProductSqlite3 を生成する。
 * 実装理由: 公式インターフェース完全準拠のもと、透過的なベクトル検索機能を付加した単一エントリを提供するため。
 * @param factory - 公式 SQLite3 ファクトリ関数。
 * @param options - 初期化オプション (公式オプション + embedding)。
 * @param env - 実行環境情報。
 * @param prepareInference - 任意の推論セッション準備関数。
 * @returns 拡張機能付き ProductSqlite3 インスタンス。
 */
export async function initializeOfficialRuntime(
  factory: OfficialFactory,
  options: ProductInitOptions = {},
  env: EnvironmentInfo,
  prepareInference?: (options: ValidatedEmbeddingOptions) => Promise<OfficialInferenceSession>
): Promise<ProductSqlite3> {
  const { embedding: embeddingOpt, ...officialOptions } = options;

  // 1. 公式オプションを転送してファクトリを起動
  const sqlite3 = (await factory(officialOptions as ProductInitOptions)) as ProductSqlite3;

  // 2. 埋め込みオプションの検証
  const validated = validateEmbeddingOptions(embeddingOpt, env);

  let session: OfficialInferenceSession | null = null;
  if (validated && prepareInference) {
    session = await prepareInference(validated);
  }

  // 3. 拡張機能の登録
  const extensionControl = registerEmbeddingExtension(sqlite3, session?.infer, {
    identity: session?.identity,
    timeoutMs: validated?.sqlTimeoutMs ?? 120000,
    information: session?.information,
    models: validated?.models,
    defaultModel: validated?.defaultModel
  });

  // 4. SAH pool の追跡フック (ブラウザ環境)
  const trackedPools: Array<{ pauseVfs(): void; removeVfs(): void }> = [];
  if (typeof sqlite3.installOpfsSAHPoolVfs === "function") {
    const originalInstall = sqlite3.installOpfsSAHPoolVfs.bind(sqlite3);
    sqlite3.installOpfsSAHPoolVfs = async (poolOpts?: unknown) => {
      const pool = await originalInstall(poolOpts);
      if (pool && typeof pool.pauseVfs === "function") {
        trackedPools.push(pool);
      }
      return pool;
    };
  }

  // 5. 埋め込み制御 API の付加
  let isClosed = false;
  sqlite3.embedding = {
    async close(): Promise<void> {
      if (isClosed) return;

      // データベース接続が使用中であれば E_DB_IN_USE を投げる
      await extensionControl.close();

      // セッションの終了
      if (session) {
        await session.close();
      }

      // SAH pool の pause (removeVfs は呼ばない)
      for (const p of trackedPools) {
        try {
          p.pauseVfs();
        } catch {
          // 無視
        }
      }

      isClosed = true;
    }
  };

  return sqlite3;
}
