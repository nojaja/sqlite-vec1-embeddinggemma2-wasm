import { VectorError } from "../errors";
import type { Sqlite3Static, Database } from "./types";
import { ModelIdentity, initializeOfficialMetadata, OfficialMetadataProtection } from "./metadata";
import { calculateCosineDistance } from "./vector-metadata";
import { StatementLifecycle } from "../sqlite/statement-lifecycle";
import { OfficialLifecycleAdapter } from "./lifecycle-adapter";
import { embeddingSqlValue, EmbeddingInference, EmbeddingCall } from "./functions";
import type { EmbeddingCacheIdentity, StatementEmbeddingCache } from "../inference/statement-embedding-cache";

/**
 * 処理名: 埋め込み登録オプション
 */
export interface EmbeddingRegistrationOptions {
  identity?: ModelIdentity;
  timeoutMs?: number;
  information?: Record<string, unknown>;
  models?: Record<string, unknown>;
  defaultModel?: string;
}

/**
 * 処理名: 埋め込み拡張登録関数
 * 処理概要: SQLite ランタイムへ gemma_model_info, embedding, embedding_query, DISTANCE を登録し、DB 接続の追跡とメタデータ初期化を連携する。
 * 実装理由: 公式 sqlite3 インスタンスにベクトル推論機能とスキーマ保護を透過的に組み込むため。
 * @param sqlite3 - SQLite3 静的インターフェース。
 * @param infer - 推論実行関数 (省略時は推論無効モード)。
 * @param options - 登録オプション。
 * @returns 埋め込み制御オブジェクト ({ close(): Promise<void> })。
 */
export function registerEmbeddingExtension(
  sqlite3: Sqlite3Static,
  infer?: (req: { operation: "query" | "document" | "image"; body?: string; title?: string; bytes?: Uint8Array; mime?: string; model?: string }) => unknown,
  options?: EmbeddingRegistrationOptions
): { close(): Promise<void> } {
  const cacheIdentity: EmbeddingCacheIdentity = {
    modelId: options?.identity?.modelId ?? "default-model",
    revision: options?.identity?.revision ?? "0.0.1",
    fingerprint: options?.identity?.fingerprint ?? "default-fingerprint",
    profile: options?.identity?.profile ?? "default-profile",
    backend: options?.identity?.backend ?? "wasm",
    runtimeGeneration: 1
  };
  const timeoutMs = options?.timeoutMs ?? 30000;
  const lifecycle = new StatementLifecycle(cacheIdentity, timeoutMs);
  const adapter = new OfficialLifecycleAdapter(sqlite3, lifecycle);
  const protection = new OfficialMetadataProtection(sqlite3);

  let functionCalls = 0;
  let closed = false;

  const originalDB = sqlite3.oo1.DB;

  /**
   * 処理名: 単一データベースへの UDF 登録
   * 処理概要: gemma_model_info, DISTANCE, embedding, embedding_query を登録する。
   * 実装理由: 各接続で一貫した SQL ベクトル関数を提供するため。
   * @param db - 対象データベース。
   */
  const setupUDFsForDb = (db: any) => {
    try {
      // 1. gemma_model_info()
      db.createFunction({
        name: "gemma_model_info",
        arity: 0,
        xFunc: () => {
          if (!infer) {
            return JSON.stringify({ ready: false });
          }
          return JSON.stringify({
            ready: true,
            ...options?.information,
            functionCalls,
            cache: lifecycle.statistics()
          });
        }
      });

      // 2. DISTANCE(a, b)
      db.createFunction({
        name: "DISTANCE",
        arity: 2,
        xFunc: (_ctx: unknown, a: unknown, b: unknown) => {
          return calculateCosineDistance(a, b);
        }
      });

      // 推論実行ラッパー (キャッシュ・ログ・統計管理)
      const inferWrapper: EmbeddingInference = (req: EmbeddingCall) => {
        functionCalls++;
        let current: any;
        try {
          if (typeof lifecycle.current === "function") {
            current = lifecycle.current();
          }
        } catch {
          // current がない場合は許容
        }

        const cache: StatementEmbeddingCache | undefined = current?.cache;
        const doInfer = (r: EmbeddingCall): Uint8Array | null => {
          try {
            const res = infer({
              operation: r.operation,
              body: (r as any).body,
              title: (r as any).title,
              bytes: (r as any).bytes,
              mime: (r as any).mime,
              model: undefined
            });
            if (res instanceof Uint8Array) {
              return res;
            }
            return null;
          } catch (err: unknown) {
            console.warn("Embedding error:", err);
            throw err;
          }
        };

        if (cache && typeof cache.resolve === "function") {
          return cache.resolve(req, doInfer);
        }
        return doInfer(req);
      };

      // 3. embedding(input, [model])
      const embeddingFunc = (_ctx: unknown, ...args: unknown[]) => {
        try {
          return embeddingSqlValue("embedding", args, infer ? inferWrapper : undefined);
        } catch (err) {
          if (!infer && err instanceof VectorError && err.code === "E_EMBEDDING_NOT_READY") {
            console.warn("Embedding error: E_EMBEDDING_NOT_READY");
          }
          throw err;
        }
      };

      db.createFunction({
        name: "embedding",
        arity: 1,
        directOnly: true,
        xFunc: embeddingFunc
      });
      db.createFunction({
        name: "embedding",
        arity: 2,
        directOnly: true,
        xFunc: embeddingFunc
      });

      // 4. embedding_query(input, [model])
      const embeddingQueryFunc = (_ctx: unknown, ...args: unknown[]) => {
        try {
          return embeddingSqlValue("embedding_query", args, infer ? inferWrapper : undefined);
        } catch (err) {
          if (!infer && err instanceof VectorError && err.code === "E_EMBEDDING_NOT_READY") {
            console.warn("Embedding error: E_EMBEDDING_NOT_READY");
          }
          throw err;
        }
      };

      db.createFunction({
        name: "embedding_query",
        arity: 1,
        directOnly: true,
        xFunc: embeddingQueryFunc
      });
      db.createFunction({
        name: "embedding_query",
        arity: 2,
        directOnly: true,
        xFunc: embeddingQueryFunc
      });
    } catch {
      // 登録エラーは無視
    }
  };

  // sqlite3.oo1.DB をラップして接続ライフサイクルとメタデータを自動管理
  function WrappedDB(this: Database, ...args: any[]) {
    const instance = Reflect.construct(originalDB, args, WrappedDB);

    // 既存メタデータの検証または新規初期化
    try {
      const metaTableCount = instance.selectValue("SELECT count(*) FROM sqlite_schema WHERE type='table' AND name='_svw_meta'");
      if (metaTableCount === 0) {
        const userTableCount = instance.selectValue("SELECT count(*) FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'");
        if (userTableCount > 0) {
          try {
            instance.close();
          } catch {
            // 無視
          }
          throw new VectorError("E_MODEL_UNBOUND");
        }
        if (options?.identity) {
          initializeOfficialMetadata(sqlite3, instance, options.identity);
        }
      } else {
        if (options?.identity) {
          initializeOfficialMetadata(sqlite3, instance, options.identity);
        }
      }
    } catch (err) {
      if (err instanceof VectorError) {
        throw err;
      }
      // その他は無視
    }

    setupUDFsForDb(instance);
    adapter.observe(instance);
    protection.observe(instance);

    return instance;
  }
  Object.setPrototypeOf(WrappedDB.prototype, originalDB.prototype);
  Object.setPrototypeOf(WrappedDB, originalDB);

  (sqlite3.oo1 as any).DB = WrappedDB;

  return {
    async close(): Promise<void> {
      if (closed) {
        return;
      }
      adapter.assertClosed();
      closed = true;
      (sqlite3.oo1 as any).DB = originalDB;
      adapter.dispose();
      protection.dispose();
    }
  };
}
