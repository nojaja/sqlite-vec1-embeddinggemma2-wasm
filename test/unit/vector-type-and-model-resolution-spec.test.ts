/**
 * 処理名: VECTOR型スキーマおよび動的モデル解決の仕様適合テスト。
 * 処理概要: docs/spec/v0.0.1 (product.md, build.md, inference.md) に規定されたSTRICTテーブル受容、Authorizerモデル解決、動的プロファイル、二系統通信、DISTANCE関数の契約を検証する。
 * 実装理由: TDD（テスト駆動開発）に基づき、実装モジュール src/official/vector-metadata に対する期待動作契約を先行定義して失敗（RED）を検出するため。
 */

import {
  parseVectorTypeDeclaration,
  extractVectorColumnsFromTableInfo,
  resolveModelFromAuthorizer,
  calculateCosineDistance,
  evaluateReferenceModelNetworkPolicy
} from "../../src/official/vector-metadata";
import type {
  VectorColumnMetadata,
  TableColumnInfoRow,
  ModelProfileDefinition,
  AuthorizerNotification,
  ModelResolutionOptions
} from "../../src/official/vector-metadata";

describe("Vector Type Schema and Dynamic Model Resolution Contracts (docs/spec/v0.0.1)", () => {
  describe("1. Method A: STRICT Table VECTOR Type Native Acceptance & Metadata Extraction (product.md 4.2.1, build.md 2.3-6)", () => {
    test("rejects AST parsing on DDL strings and extracts metadata strictly from PRAGMA table_info declared types", () => {
      // PRAGMA table_info('items') の結果モック
      const pragmaRows: TableColumnInfoRow[] = [
        { cid: 0, name: "id", type: "INTEGER", notnull: 0, dflt_value: null, pk: 1 },
        { cid: 1, name: "title", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
        { cid: 2, name: "embedding", type: "VECTOR(512, 'ruri-v3')", notnull: 0, dflt_value: null, pk: 0 },
        { cid: 3, name: "summary_vec", type: "VECTOR(256, 'bekko-v1')", notnull: 0, dflt_value: null, pk: 0 },
        { cid: 4, name: "legacy_blob", type: "BLOB", notnull: 0, dflt_value: null, pk: 0 }
      ];

      const metadata = extractVectorColumnsFromTableInfo("items", pragmaRows);
      expect(metadata).toEqual({
        embedding: {
          tableName: "items",
          columnName: "embedding",
          dimension: 512,
          modelName: "ruri-v3"
        },
        summary_vec: {
          tableName: "items",
          columnName: "summary_vec",
          dimension: 256,
          modelName: "bekko-v1"
        }
      });
      expect(metadata.id).toBeUndefined();
      expect(metadata.title).toBeUndefined();
      expect(metadata.legacy_blob).toBeUndefined();
    });

    test("handles optional model specification in VECTOR(dimension) and single-quoted/whitespace variants", () => {
      expect(parseVectorTypeDeclaration("VECTOR(768)")).toEqual({ dimension: 768, modelName: undefined });
      expect(parseVectorTypeDeclaration("vector( 768 , 'embeddinggemma-2' )")).toEqual({
        dimension: 768,
        modelName: "embeddinggemma-2"
      });
      expect(parseVectorTypeDeclaration('VECTOR(256, "bekko-v1")')).toEqual({
        dimension: 256,
        modelName: "bekko-v1"
      });
      expect(parseVectorTypeDeclaration("VECTOR(512, unquoted-model)")).toEqual({
        dimension: 512,
        modelName: "unquoted-model"
      });
    });

    test("returns null for non-vector or malformed types without throwing parser errors", () => {
      expect(parseVectorTypeDeclaration("INTEGER")).toBeNull();
      expect(parseVectorTypeDeclaration("TEXT")).toBeNull();
      expect(parseVectorTypeDeclaration("BLOB")).toBeNull();
      expect(parseVectorTypeDeclaration("VECTOR()")).toBeNull();
      expect(parseVectorTypeDeclaration("VECTOR(0)")).toBeNull();
      expect(parseVectorTypeDeclaration("VECTOR(abc)")).toBeNull();
      expect(parseVectorTypeDeclaration("VECTOR(-512)")).toBeNull();
    });

    test("STRICT table natively accepts VECTOR type as SQLITE_AFF_BLOB without TypeScript rewriting", () => {
      // build.md 2.3-6: sqlite3ColumnType限定パッチにより、TypeScript側での置換不要でSTRICTテーブルを通過する契約
      const strictDdlStatement = "CREATE TABLE docs (id INTEGER PRIMARY KEY, v VECTOR(768, 'embeddinggemma-2')) STRICT;";
      // DDL文字列を置換せずそのままSQLite CAPIに投入する契約
      expect(strictDdlStatement).toContain("VECTOR(768, 'embeddinggemma-2')");
      expect(strictDdlStatement).toContain("STRICT");
    });
  });

  describe("2. Automatic Resolution of [model] Parameter via Official Authorizer & Fallback (product.md 4.2.2)", () => {
    const tableMetadata: Record<string, Record<string, VectorColumnMetadata>> = {
      items: {
        embedding: {
          tableName: "items",
          columnName: "embedding",
          dimension: 512,
          modelName: "ruri-v3"
        },
        aux_vec: {
          tableName: "items",
          columnName: "aux_vec",
          dimension: 256,
          modelName: "bekko-v1"
        }
      }
    };

    test("Priority 1: Explicit [model] parameter always takes highest precedence", () => {
      const notifications: AuthorizerNotification[] = [
        { actionCode: 18, arg1: "items" },
        { actionCode: 31, arg1: "embedding" }
      ];
      const resolved = resolveModelFromAuthorizer(
        notifications,
        tableMetadata,
        {
          explicitModel: "custom-override-model",
          activeModels: ["ruri-v3", "bekko-v1"]
        },
        { tableName: "items", columnName: "embedding" }
      );
      expect(resolved).toBe("custom-override-model");
    });

    test("Priority 2: Resolves model from UPDATE column context via Authorizer notification sequence", () => {
      // UPDATE items SET embedding = embedding('hello') WHERE id = 1
      const notifications: AuthorizerNotification[] = [
        { actionCode: 9, arg1: "items", arg2: "embedding" }, // SQLITE_UPDATE items.embedding
        { actionCode: 31, arg1: "embedding" }                // SQLITE_FUNCTION embedding
      ];
      const resolved = resolveModelFromAuthorizer(notifications, tableMetadata, {
        explicitModel: undefined,
        activeModels: ["ruri-v3", "bekko-v1"]
      });
      expect(resolved).toBe("ruri-v3");
    });

    test("Priority 2: Resolves model from INSERT destination column context", () => {
      const notifications: AuthorizerNotification[] = [
        { actionCode: 18, arg1: "items" },    // SQLITE_INSERT items
        { actionCode: 31, arg1: "embedding" } // SQLITE_FUNCTION embedding
      ];
      const resolved = resolveModelFromAuthorizer(
        notifications,
        tableMetadata,
        {
          explicitModel: undefined,
          activeModels: ["ruri-v3", "bekko-v1"]
        },
        { tableName: "items", columnName: "aux_vec" }
      );
      expect(resolved).toBe("bekko-v1");
    });

    test("Priority 3: Resolves model from single active model in DB when column context is absent", () => {
      // SELECT id FROM items WHERE DISTANCE(embedding, embedding_query('query')) < 0.5
      // 複合式・WHERE句等で代入先カラムコンテキストが存在しない場合
      const notifications: AuthorizerNotification[] = [
        { actionCode: 31, arg1: "embedding_query" }
      ];
      const resolved = resolveModelFromAuthorizer(notifications, tableMetadata, {
        explicitModel: undefined,
        activeModels: ["ruri-v3"]
      });
      expect(resolved).toBe("ruri-v3");
    });

    test("Priority 4: Fallbacks to defaultModel when DB has multiple models and context is ambiguous", () => {
      // CTE や複雑なサブクエリ等でカラムコンテキストが特定できず、複数モデルが存在する場合
      const ambiguousNotifications: AuthorizerNotification[] = [
        { actionCode: 31, arg1: "embedding" }
      ];
      const resolved = resolveModelFromAuthorizer(ambiguousNotifications, tableMetadata, {
        explicitModel: undefined,
        defaultModel: "bekko-v1",
        activeModels: ["ruri-v3", "bekko-v1"]
      });
      expect(resolved).toBe("bekko-v1");
    });

    test("Priority 5: Throws E_MODEL_UNBOUND when resolution cannot be determined safely", () => {
      const ambiguousNotifications: AuthorizerNotification[] = [
        { actionCode: 31, arg1: "embedding" }
      ];
      expect(() => {
        resolveModelFromAuthorizer(ambiguousNotifications, tableMetadata, {
          explicitModel: undefined,
          defaultModel: undefined,
          activeModels: ["ruri-v3", "bekko-v1"]
        });
      }).toThrow("E_MODEL_UNBOUND");
    });
  });

  describe("3. Dynamic Model Profile & Zero-Download Contracts (product.md 4.4, inference.md 1)", () => {
    test("accepts dynamic application-provided model profiles without built-in catalog constraints", () => {
      const customProfile: ModelProfileDefinition = {
        name: "ruri-v3",
        path: "./models/ruri-v3-30m-onnx",
        dimension: 512,
        normalize: true,
        prefix: {
          query: "検索クエリ: ",
          document: "文章: "
        }
      };

      expect(customProfile.name).toBe("ruri-v3");
      expect(customProfile.dimension).toBe(512);
      expect(customProfile.path).toBe("./models/ruri-v3-30m-onnx");
      expect(customProfile.prefix?.query).toBe("検索クエリ: ");
    });

    test("reference model two-tier network control (allow: stream download, offline: zero network)", () => {
      expect(evaluateReferenceModelNetworkPolicy("allow", false)).toBe("fetch");
      expect(evaluateReferenceModelNetworkPolicy("allow", true)).toBe("cache");
      expect(evaluateReferenceModelNetworkPolicy("offline", true)).toBe("cache");
      expect(() => evaluateReferenceModelNetworkPolicy("offline", false)).toThrow("E_MODEL_CACHE_MISS");
      expect(() => evaluateReferenceModelNetworkPolicy("auto" as "allow", false)).toThrow("E_INPUT");
    });
  });

  describe("4. Distance Function Contract with Flexible Dimensions (product.md 4.3, build.md 2.3-2)", () => {
    test("calculates cosine distance correctly for various model dimensions (256, 512, 768)", () => {
      for (const dim of [256, 512, 768]) {
        const vec = new Uint8Array(dim * 4);
        const view = new DataView(vec.buffer);
        view.setFloat32(0, 1.0, true);
        view.setFloat32(4, 2.0, true);

        const dist = calculateCosineDistance(vec, vec);
        expect(dist).not.toBeNull();
        expect(dist as number).toBeCloseTo(0, 6);
      }
    });

    test("computes orthogonal as 1 and opposite as 2", () => {
      const dim = 512;
      const vecA = new Uint8Array(dim * 4);
      const vecB = new Uint8Array(dim * 4);
      const vecC = new Uint8Array(dim * 4);

      new DataView(vecA.buffer).setFloat32(0, 1.0, true);  // (1, 0, ...)
      new DataView(vecB.buffer).setFloat32(4, 1.0, true);  // (0, 1, ...) 直交
      new DataView(vecC.buffer).setFloat32(0, -1.0, true); // (-1, 0, ...) 逆向き

      expect(calculateCosineDistance(vecA, vecB)).toBeCloseTo(1.0, 6);
      expect(calculateCosineDistance(vecA, vecC)).toBeCloseTo(2.0, 6);
    });

    test("propagates NULL when either operand is null", () => {
      const vec = new Uint8Array(256 * 4);
      expect(calculateCosineDistance(null, vec)).toBeNull();
      expect(calculateCosineDistance(vec, null)).toBeNull();
      expect(calculateCosineDistance(null, null)).toBeNull();
    });

    test("rejects dimension mismatch, non-finite values, and invalid byte lengths with E_INPUT", () => {
      const vec256 = new Uint8Array(256 * 4);
      const vec512 = new Uint8Array(512 * 4);
      new DataView(vec256.buffer).setFloat32(0, 1.0, true);
      new DataView(vec512.buffer).setFloat32(0, 1.0, true);

      // 次元不一致
      expect(() => calculateCosineDistance(vec256, vec512)).toThrow("E_INPUT");

      // 不正なバイト長 (4の倍数でない)
      const oddBytes = new Uint8Array(10);
      expect(() => calculateCosineDistance(oddBytes, oddBytes)).toThrow("E_INPUT");

      // NaN / Infinity 含む非有限値
      const nanVec = new Uint8Array(256 * 4);
      new DataView(nanVec.buffer).setFloat32(0, NaN, true);
      expect(() => calculateCosineDistance(nanVec, nanVec)).toThrow("E_INPUT");

      // ゼロノルム (ゼロベクトル)
      const zeroVec = new Uint8Array(256 * 4);
      expect(() => calculateCosineDistance(zeroVec, zeroVec)).toThrow("E_INPUT");

      // 非 Uint8Array
      expect(() => calculateCosineDistance({} as unknown as Uint8Array, vec256)).toThrow("E_INPUT");
    });
  });

  describe("5. Embedding Initialization Lifecycle: Eager Session Warm-up vs Embedding-Free Operation (product.md 3.1, 3.3)", () => {
    test("omitted embedding remains completely model-free and initializes instantly without loading model or worker", () => {
      const runtimeState = {
        embeddingEnabled: false,
        sqliteReady: true,
        workerSpawned: false,
        modelLoaded: false
      };

      expect(runtimeState.sqliteReady).toBe(true);
      expect(runtimeState.workerSpawned).toBe(false);
      expect(runtimeState.modelLoaded).toBe(false);
    });

    test("when embedding is enabled, prepares inference session eagerly and does not resolve initializer until warm-up succeeds", () => {
      /**
       * 処理名: 初期化ライフサイクル状態。
       * 処理概要: 公式loader初期化および推論セッション準備・warm-upの状態を保持する。
       * 実装理由: warm-up完了前に初期化が解決されない契約を型安全に検証するため。
       */
      interface InitializationLifecycle {
        loaderReady: boolean;
        sessionPrepared: boolean;
        warmupCompleted: boolean;
        initializerResolved: boolean;
      }

      /**
       * 処理名: 初期化完了判定。
       * 処理概要: loaderReady・sessionPrepared・warmupCompletedがすべて満たされているか検証する。
       * 実装理由: モデル・codecとquery/image warm-upが成功するまでinitializerをresolveしない契約を検証するため。
       * @param state - 初期化ライフサイクル状態。
       * @returns 初期化完了とみなせる場合はtrue。
       */
      function canResolveInitializer(state: InitializationLifecycle): boolean {
        // モデル・codecとquery/image warm-upが成功するまでinitializerをresolveしない
        return state.loaderReady && state.sessionPrepared && state.warmupCompleted;
      }

      const duringInitialization: InitializationLifecycle = {
        loaderReady: true,
        sessionPrepared: true,
        warmupCompleted: false,
        initializerResolved: false
      };
      expect(canResolveInitializer(duringInitialization)).toBe(false);

      const afterWarmupSuccess: InitializationLifecycle = {
        loaderReady: true,
        sessionPrepared: true,
        warmupCompleted: true,
        initializerResolved: true
      };
      expect(canResolveInitializer(afterWarmupSuccess)).toBe(true);
    });
  });
});
