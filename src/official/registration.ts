import { VectorError } from "../errors";
import type { Sqlite3Static, Database } from "./types";
import { ModelIdentity, initializeOfficialMetadata, OfficialMetadataProtection } from "./metadata";
import {
  calculateCosineDistance,
  extractVectorColumnsFromTableInfo,
  resolveModelFromAuthorizer,
  type TableColumnInfoRow,
  type VectorColumnMetadata
} from "./vector-metadata";
import { StatementLifecycle } from "../sqlite/statement-lifecycle";
import { OfficialLifecycleAdapter } from "./lifecycle-adapter";
import { embeddingSqlValue, EmbeddingInference, EmbeddingCall } from "./functions";
import type { EmbeddingCacheIdentity, StatementEmbeddingCache } from "../inference/statement-embedding-cache";
import type { ModelConfigOptions } from "./options";

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

  const allowedModels = new Set<string>(
    options?.models ? Object.keys(options.models) : ["embeddinggemma-2"]
  );
  if (options?.defaultModel) {
    allowedModels.add(options.defaultModel);
  }

  /**
   * 処理名: モデル情報サマリー構築
   * 処理概要: gemma_model_info() 向けに登録モデル一覧の次元数・dtype・ロード状態を構築する。
   * 実装理由: マルチモデル環境でどのモデルが利用可能かを診断関数から取得可能にするため。
   * @returns モデル情報マップ、または未設定時 undefined。
   */
  const buildModelsInfo = (): Record<string, unknown> | undefined => {
    const infoModels = (options?.information?.models as Record<string, unknown> | undefined) ?? undefined;
    if (infoModels) {
      return infoModels;
    }
    if (!options?.models) {
      return undefined;
    }
    const result: Record<string, unknown> = {};
    for (const [name, cfg] of Object.entries(options.models)) {
      const m = typeof cfg === "object" && cfg !== null ? (cfg as ModelConfigOptions) : undefined;
      result[name] = {
        dimension: m?.dimension ?? 768,
        dtype: m?.dtype ?? "q4",
        loaded: name === (options.defaultModel ?? "embeddinggemma-2")
      };
    }
    return result;
  };

  const originalDB = sqlite3.oo1.DB;

  /**
   * 処理名: 単一データベースへの UDF 登録
   * 処理概要: gemma_model_info, DISTANCE, embedding, embedding_query を登録し、Authorizer と VECTOR スキーマ検証を接続する。
   * 実装理由: 各接続で一貫した SQL ベクトル関数と VECTOR(dim, 'model') 整合性チェックを提供するため。
   * @param db - 対象データベース。
   */
  const setupUDFsForDb = (db: any) => {
    try {
      const tableMetadata: Record<string, Record<string, VectorColumnMetadata>> = {};
      const triggeredCols = new Set<string>();
      let isSyncing = false;
      let lastInsertTable: string | undefined;
      let lastUpdateTarget: { table: string; column: string } | undefined;

      /**
       * 処理名: VECTOR スキーマおよび一時検証トリガー同期
       * 処理概要: sqlite_schema と PRAGMA table_info から VECTOR 列を収集し、生 BLOB 次元チェック用の一時トリガーを設置する。
       * 実装理由: 永続スキーマを汚さずに INSERT/UPDATE 時の異次元 BLOB を E_EMBEDDING_VALUE で拒否するため。
       */
      const syncVectorSchema = (): void => {
        if (isSyncing) return;
        isSyncing = true;
        try {
          const stmt = db.prepare(
            "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_svw_%'"
          );
          const tableNames: string[] = [];
          try {
            while (stmt.step()) {
              tableNames.push(String(stmt.getString(0)));
            }
          } finally {
            stmt.finalize();
          }

          for (const key of Object.keys(tableMetadata)) {
            delete tableMetadata[key];
          }

          for (const tbl of tableNames) {
            const escapedTbl = tbl.replace(/"/g, '""');
            const pStmt = db.prepare(`PRAGMA table_info("${escapedTbl}")`);
            const rows: TableColumnInfoRow[] = [];
            try {
              while (pStmt.step()) {
                const row = pStmt.get({}) as unknown as TableColumnInfoRow;
                rows.push(row);
              }
            } finally {
              pStmt.finalize();
            }
            const cols = extractVectorColumnsFromTableInfo(tbl, rows);
            if (Object.keys(cols).length > 0) {
              tableMetadata[tbl] = cols;
              for (const col of Object.values(cols)) {
                const triggerKey = `${tbl}.${col.columnName}:${col.dimension}`;
                if (!triggeredCols.has(triggerKey)) {
                  const expectedBytes = col.dimension * 4;
                  const escCol = col.columnName.replace(/"/g, '""');
                  const safeName = `${tbl}_${col.columnName}`.replace(/[^A-Za-z0-9_]/g, "_");
                  db.exec(
                    `CREATE TEMP TRIGGER IF NOT EXISTS "svw_vec_chk_${safeName}_ins" BEFORE INSERT ON "${escapedTbl}" ` +
                      `WHEN NEW."${escCol}" IS NOT NULL AND (typeof(NEW."${escCol}") != 'blob' OR length(NEW."${escCol}") != ${expectedBytes}) ` +
                      `BEGIN SELECT RAISE(ABORT, 'E_EMBEDDING_VALUE'); END;`
                  );
                  db.exec(
                    `CREATE TEMP TRIGGER IF NOT EXISTS "svw_vec_chk_${safeName}_upd" BEFORE UPDATE ON "${escapedTbl}" ` +
                      `WHEN NEW."${escCol}" IS NOT NULL AND (typeof(NEW."${escCol}") != 'blob' OR length(NEW."${escCol}") != ${expectedBytes}) ` +
                      `BEGIN SELECT RAISE(ABORT, 'E_EMBEDDING_VALUE'); END;`
                  );
                  triggeredCols.add(triggerKey);
                }
              }
            }
          }
        } catch {
          // 同期失敗は無視
        } finally {
          isSyncing = false;
        }
      };

      /**
       * 処理名: 現在のターゲット VECTOR 列特定
       * 処理概要: Authorizer 通知から現在の INSERT / UPDATE 先 VECTOR 列メタデータを返す。
       * 実装理由: 第2引数省略時のモデル自動解決および明示指定時のモデル不一致検証を行うため。
       * @returns 特定された VectorColumnMetadata、または undefined。
       */
      const resolveCurrentTargetColumn = (): VectorColumnMetadata | undefined => {
        if (lastUpdateTarget) {
          return tableMetadata[lastUpdateTarget.table]?.[lastUpdateTarget.column];
        }
        if (lastInsertTable) {
          const cols = tableMetadata[lastInsertTable];
          if (cols) {
            const entries = Object.values(cols);
            if (entries.length === 1) {
              return entries[0];
            }
          }
        }
        return undefined;
      };

      /**
       * 処理名: Authorizer ターゲット列追跡登録
       * 処理概要: INSERT/UPDATE/DDL アクションを監視し、ターゲット列とスキーマ同期状態を更新する。
       * 実装理由: 独自 SQL パーサーを設けずに SQLite 本体の構文解析コンテキストを利用するため。
       */
      if (typeof sqlite3.capi?.sqlite3_set_authorizer === "function") {
        sqlite3.capi.sqlite3_set_authorizer(
          db,
          (_ctx: unknown, action: number, arg1: unknown, arg2: unknown) => {
            if (action === 18 && typeof arg1 === "string" && !arg1.startsWith("_svw_")) {
              lastInsertTable = arg1;
              lastUpdateTarget = undefined;
            } else if (action === 23 && typeof arg1 === "string" && typeof arg2 === "string" && !arg1.startsWith("_svw_")) {
              lastUpdateTarget = { table: arg1, column: arg2 };
              lastInsertTable = undefined;
            }
            return 0;
          },
          0
        );
      }

      // exec / prepare をフックしてスキーマ同期・コンテキストリセット・エラー正規化を行う
      const origExec = db.exec.bind(db);
      db.exec = (sqlOrOpts: unknown) => {
        if (!isSyncing) {
          lastInsertTable = undefined;
          lastUpdateTarget = undefined;
          syncVectorSchema();
        }
        try {
          const res = origExec(sqlOrOpts);
          if (!isSyncing) {
            syncVectorSchema();
          }
          return res;
        } catch (err: unknown) {
          if (err instanceof Error && err.message.includes("E_EMBEDDING_VALUE")) {
            throw new VectorError("E_EMBEDDING_VALUE");
          }
          throw err;
        }
      };

      const origPrepare = db.prepare.bind(db);
      db.prepare = (sql: string) => {
        if (!isSyncing) {
          lastInsertTable = undefined;
          lastUpdateTarget = undefined;
          syncVectorSchema();
        }
        return origPrepare(sql);
      };

      // 1. gemma_model_info()
      db.createFunction({
        name: "gemma_model_info",
        arity: 0,
        xFunc: () => {
          if (!infer) {
            return JSON.stringify({ ready: false });
          }
          const modelsInfo = buildModelsInfo();
          return JSON.stringify({
            ready: true,
            ...options?.information,
            ...(modelsInfo ? { models: modelsInfo } : {}),
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
              model: r.model ?? options?.defaultModel
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

      if (!infer) {
        return;
      }

      /**
       * 処理名: コンテキスト自動モデル解決コールバック
       * 処理概要: Authorizer ターゲット列および DB メタデータからモデル名を自動解決する。
       * 実装理由: embedding(text) の第2引数省略時にテーブル定義と一致するモデルを選択するため。
       * @returns 解決されたモデル名、または undefined。
       */
      const resolveContextModel = (): string | undefined => {
        const target = resolveCurrentTargetColumn();
        if (target?.modelName) {
          return target.modelName;
        }
        try {
          return resolveModelFromAuthorizer(
            [],
            tableMetadata,
            {
              defaultModel: options?.defaultModel ?? "embeddinggemma-2",
              activeModels: Array.from(allowedModels)
            },
            lastInsertTable && target ? { table: lastInsertTable, column: target.columnName } : undefined
          );
        } catch {
          return options?.defaultModel;
        }
      };

      /**
       * 処理名: ターゲット列と生成結果の整合性検証付き推論実行
       * 処理概要: 明示モデル一致および出力次元一致を検証してから UDF 値を返却する。
       * 実装理由: VECTOR(dim, 'model') 列への異モデル・異次元混入を確実にブロックするため。
       * @param opName - UDF 名 ("embedding" | "embedding_query")。
       * @param args - UDF 引数配列。
       * @returns Float32 ベクトル BLOB または null。
       */
      const executeValidatedEmbedding = (opName: "embedding" | "embedding_query", args: unknown[]): Uint8Array | null => {
        const target = resolveCurrentTargetColumn();
        if (args.length >= 2 && typeof args[1] === "string" && allowedModels.has(args[1]) && args[0] !== null) {
          if (target?.modelName && args[1] !== target.modelName) {
            throw new VectorError("E_MODEL_MISMATCH");
          }
        }
        const res = embeddingSqlValue(opName, args, inferWrapper, allowedModels, resolveContextModel);
        if (res !== null && target && res.byteLength !== target.dimension * 4) {
          throw new VectorError("E_EMBEDDING_VALUE");
        }
        return res;
      };

      // 3. embedding(input, [model])
      const embeddingFunc = (_ctx: unknown, ...args: unknown[]) => {
        return executeValidatedEmbedding("embedding", args);
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
        return executeValidatedEmbedding("embedding_query", args);
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

    adapter.observe(instance);
    protection.observe(instance);
    setupUDFsForDb(instance);

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
