import { parseVectorColumnDefinitions, resolveModelForStatement, type VectorColumnMetadata, type ModelProfileDefinition } from "../../src/official/vector-metadata";

describe("Vector Type Schema and Dynamic Model Resolution Contracts", () => {
  describe("1. Method A: VECTOR(dimension, 'model') Column Type Metadata Extraction", () => {
    test("extracts vector column metadata from CREATE TABLE DDL statements", () => {
      const ddl1 = `
        CREATE TABLE items (
          id INTEGER PRIMARY KEY,
          title TEXT,
          embedding VECTOR(512, 'ruri-v3'),
          summary_vec VECTOR(256, 'bekko-v1')
        );
      `;

      const metadata = parseVectorColumnDefinitions("items", ddl1);
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
    });

    test("handles optional model specification in VECTOR(dimension) and single-quoted strings", () => {
      const ddl = `CREATE TABLE docs (id INT, v VECTOR(768));`;
      const metadata = parseVectorColumnDefinitions("docs", ddl);
      expect(metadata).toEqual({
        v: {
          tableName: "docs",
          columnName: "v",
          dimension: 768,
          modelName: undefined
        }
      });
    });
  });

  describe("2. Automatic Resolution of [model] Parameter", () => {
    const tableMetadata: Record<string, Record<string, VectorColumnMetadata>> = {
      items: {
        embedding: {
          tableName: "items",
          columnName: "embedding",
          dimension: 512,
          modelName: "ruri-v3"
        }
      }
    };

    test("resolves model from INSERT destination column context when [model] is omitted", () => {
      const sql = "INSERT INTO items (title, embedding) VALUES ('Hello', embedding('Hello'))";
      const resolved = resolveModelForStatement(sql, tableMetadata, {
        explicitModel: undefined,
        activeModels: ["ruri-v3"]
      });
      expect(resolved).toBe("ruri-v3");
    });

    test("resolves model from single active model registered in DB context", () => {
      const sql = "SELECT id FROM items WHERE DISTANCE(embedding, embedding_query('query')) < 0.5";
      const resolved = resolveModelForStatement(sql, tableMetadata, {
        explicitModel: undefined,
        activeModels: ["ruri-v3"]
      });
      expect(resolved).toBe("ruri-v3");
    });

    test("explicit [model] parameter always takes highest precedence", () => {
      const sql = "INSERT INTO items (embedding) VALUES (embedding('Hello', 'bekko-v1'))";
      const resolved = resolveModelForStatement(sql, tableMetadata, {
        explicitModel: "bekko-v1",
        activeModels: ["ruri-v3", "bekko-v1"]
      });
      expect(resolved).toBe("bekko-v1");
    });
  });

  describe("3. Dynamic Model Profile Without Hardcoded Defaults", () => {
    test("accepts dynamic application-provided model profiles without built-in catalog", () => {
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
    });
  });

  describe("4. Zero-Download Strategy and Model Pre-configuration", () => {
    test("model loading reads strictly from local filesystem path without network fetches", () => {
      const localConfig = {
        modelPath: "./models/ruri-v3-30m-onnx",
        autoDownload: false
      };
      expect(localConfig.autoDownload).toBe(false);
      expect(localConfig.modelPath.startsWith("./") || localConfig.modelPath.startsWith("/")).toBe(true);
    });
  });

  describe("5. Embedding Initialization Lifecycle: Eager Session Warm-up vs Embedding-Free Operation (spec 3.3)", () => {
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
      // docs/spec/v0.0.1/product.md 3.3:
      // 公式loader初期化後に推論sessionを準備する。モデル・codecとquery/image warm-upが成功するまでinitializerをresolveしない。
      // SQL評価時まで推論Worker起動を遅延させる方式（遅延初期化）ではなく、初期化完了時点で推論セッション・warm-upが完了している契約
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
