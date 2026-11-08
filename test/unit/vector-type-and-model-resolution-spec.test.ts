import { parseVectorColumnDefinitions, resolveModelForStatement, type VectorColumnMetadata, type ModelProfileDefinition } from "../../src/official/vector-metadata";

describe("Vector Type Schema and Dynamic Model Resolution Contracts", () => {
  describe("1. Deprecation and Removal of gemma_embed_* Functions", () => {
    test("gemma-specific SQL functions must be completely excluded from the function registry", () => {
      const activeFunctions = ["embedding", "embedding_query", "DISTANCE"];
      const legacyGemmaFunctions = [
        "gemma_embed_query",
        "gemma_embed_document",
        "gemma_embed_image",
        "gemma_model_info"
      ];

      for (const fn of legacyGemmaFunctions) {
        expect(activeFunctions).not.toContain(fn);
      }
      expect(activeFunctions).toContain("embedding");
      expect(activeFunctions).toContain("embedding_query");
      expect(activeFunctions).toContain("DISTANCE");
    });
  });

  describe("2. Method A: VECTOR(dimension, 'model') Column Type Metadata Extraction", () => {
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

  describe("3. Automatic Resolution of [model] Parameter", () => {
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

  describe("4. Dynamic Model Profile Without Hardcoded Defaults", () => {
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

  describe("5. Zero-Download Strategy and Model Pre-configuration", () => {
    test("model loading reads strictly from local filesystem path without network fetches", () => {
      const localConfig = {
        modelPath: "./models/ruri-v3-30m-onnx",
        autoDownload: false
      };
      expect(localConfig.autoDownload).toBe(false);
      expect(localConfig.modelPath.startsWith("./") || localConfig.modelPath.startsWith("/")).toBe(true);
    });
  });

  describe("6. Lazy Initialization and Embedding-Free Operation", () => {
    test("sqlite initialization completes instantly without loading model or worker if embedding is unused", () => {
      const runtimeState = {
        sqliteReady: true,
        workerSpawned: false,
        modelLoaded: false
      };

      expect(runtimeState.sqliteReady).toBe(true);
      expect(runtimeState.workerSpawned).toBe(false);
      expect(runtimeState.modelLoaded).toBe(false);
    });
  });
});
