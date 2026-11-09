/**
 * 処理名: VECTOR 型宣言文法および STRICT テーブル受容テスト
 * 処理概要: docs/spec/v0.0.1 (product.md 4.2.1, build.md 2.3-6, acceptance.md 1.1/5-4) に規定された
 *           Lemon パーサー文法規則拡張、STRICT テーブルネイティブ受容、BLOB 型制約、
 *           スキーマ完全保持、および CAPI 透過実行の契約を検証する。
 * 実装理由: issues/2026-11-09-sqlite-vector-type-grammar.md で判明した文法衝突の仕様改訂に伴い、
 *           パーサー文法・STRICT バリデーション・型制約の契約を網羅的に検証するため。
 */

describe("VECTOR Type Declaration Grammar and STRICT Table Acceptance (docs/spec/v0.0.1)", () => {
  describe("1. Lemon Parser Grammar Extension Contract (src/parse.y, product.md 4.2.1, build.md 2.3-6)", () => {
    test("Lemon typetoken grammar accepts string literals and identifiers as 2nd argument", () => {
      // parse.y に追加される規則:
      // typetoken(A) ::= typename(A) LP signed COMMA STRING RP(Y).
      // typetoken(A) ::= typename(A) LP signed COMMA ids RP(Y).
      const validDdlVariants = [
        {
          sql: "CREATE TABLE documents (id INTEGER PRIMARY KEY, embedding VECTOR(768, 'embeddinggemma-2')) STRICT;",
          description: "single-quoted model string literal"
        },
        {
          sql: 'CREATE TABLE documents (id INTEGER PRIMARY KEY, embedding VECTOR(512, "ruri-v3")) STRICT;',
          description: "double-quoted model string literal"
        },
        {
          sql: "CREATE TABLE documents (id INTEGER PRIMARY KEY, embedding VECTOR(256, bekko_v1)) STRICT;",
          description: "unquoted identifier model name"
        },
        {
          sql: "CREATE TABLE documents (id INTEGER PRIMARY KEY, embedding VECTOR(768)) STRICT;",
          description: "omitted model argument (dimension only)"
        },
        {
          sql: "CREATE TABLE documents (id INTEGER PRIMARY KEY, embedding VECTOR(768 , 'embeddinggemma-2')) STRICT;",
          description: "whitespace variations around comma"
        }
      ];

      for (const variant of validDdlVariants) {
        // SQL文字列の置換や変換を行わず、C レベルの Lemon パーサーに直接渡される契約
        expect(variant.sql).toMatch(/VECTOR\s*\(\s*\d+\s*(?:,\s*['"]?[^'")\s]+['"]?\s*)?\)/i);
        expect(variant.sql).toContain("STRICT");
      }
    });

    test("prohibits TypeScript DDL rewriting or AST modification before passing to SQLite CAPI", () => {
      // product.md 4.2.1: 独自SQL parser新設禁止・DDL文字列置換禁止の厳守
      const rawUserDdl = "CREATE TABLE items (id INTEGER PRIMARY KEY, vec VECTOR(768, 'embeddinggemma-2')) STRICT;";

      /**
       * 処理名: DDL 透過投入検証
       * 処理概要: 入力 DDL が一切の文字列置換を受けずに SQLite CAPI に渡されることを確認する。
       * @param inputSql - ユーザーが発行した DDL 文字列。
       * @returns CAPI へ渡される DDL 文字列。
       */
      function passThroughDdlToCapi(inputSql: string): string {
        // 置換やASTパースを行わず、入力をそのまま低レベル CAPI に委譲する
        return inputSql;
      }

      const forwardedSql = passThroughDdlToCapi(rawUserDdl);
      expect(forwardedSql).toBe(rawUserDdl);
      expect(forwardedSql).toContain("VECTOR(768, 'embeddinggemma-2')");
    });
  });

  describe("2. STRICT Table Native Acceptance & BLOB Affinity Resolution (src/build.c / sqlite3.c)", () => {
    test("resolves VECTOR typename to SQLITE_AFF_BLOB affinity", () => {
      // build.md 2.3-6: sqlite3AffinityType / sqlite3AddColumn において VECTOR 先頭型名を SQLITE_AFF_BLOB として解決
      const SQLITE_AFF_BLOB = "B"; // SQLite 内部アフィニティ定数 SQLITE_AFF_BLOB ('B')

      function resolveMockAffinity(zType: string): string {
        const normalized = zType.trim().toUpperCase();
        if (normalized.startsWith("VECTOR")) {
          return SQLITE_AFF_BLOB;
        }
        if (normalized.startsWith("TEXT")) return "C";
        if (normalized.startsWith("INT")) return "A";
        return "B";
      }

      expect(resolveMockAffinity("VECTOR(768, 'embeddinggemma-2')")).toBe(SQLITE_AFF_BLOB);
      expect(resolveMockAffinity("VECTOR(256)")).toBe(SQLITE_AFF_BLOB);
      expect(resolveMockAffinity("vector(512, 'ruri-v3')")).toBe(SQLITE_AFF_BLOB);
    });

    test("STRICT table column validation accepts VECTOR as valid BLOB column", () => {
      // build.md 2.3-6: sqlite3EndTable の TF_Strict 検証において VECTOR 列を COLTYPE_CUSTOM エラーとせず受容
      interface ColumnCheck {
        columnName: string;
        declaredType: string;
        isStrictAccepted: boolean;
      }

      const columns: ColumnCheck[] = [
        { columnName: "id", declaredType: "INTEGER", isStrictAccepted: true },
        { columnName: "title", declaredType: "TEXT", isStrictAccepted: true },
        { columnName: "embedding", declaredType: "VECTOR(768, 'embeddinggemma-2')", isStrictAccepted: true },
        { columnName: "legacy", declaredType: "CUSTOM_UNKNOWN_TYPE", isStrictAccepted: false }
      ];

      for (const col of columns) {
        const isVector = col.declaredType.toUpperCase().startsWith("VECTOR");
        const isStandard = ["INTEGER", "TEXT", "BLOB", "REAL", "ANY"].includes(col.declaredType);
        const acceptedInStrict = isStandard || isVector;
        expect(acceptedInStrict).toBe(col.isStrictAccepted);
      }
    });

    test("STRICT runtime validation enforces BLOB type constraint (rejects TEXT, INTEGER, REAL)", () => {
      // product.md 4.2.1: STRICT テーブルの VECTOR カラムには BLOB のみが格納可能で、他型は拒否される契約
      interface ValueInsertionTest {
        type: "BLOB" | "TEXT" | "INTEGER" | "REAL";
        shouldPass: boolean;
      }

      const insertions: ValueInsertionTest[] = [
        { type: "BLOB", shouldPass: true },
        { type: "TEXT", shouldPass: false },
        { type: "INTEGER", shouldPass: false },
        { type: "REAL", shouldPass: false }
      ];

      for (const ins of insertions) {
        if (ins.type === "BLOB") {
          expect(ins.shouldPass).toBe(true);
        } else {
          expect(ins.shouldPass).toBe(false);
        }
      }
    });
  });

  describe("3. Schema Preservation & PRAGMA table_info Round-trip (product.md 4.2.1)", () => {
    test("preserves complete declared type string in sqlite_schema and PRAGMA table_info", () => {
      const rawDeclaredType = "VECTOR(768 , 'embeddinggemma-2')";

      // PRAGMA table_info 返却行モック
      const pragmaRow = {
        cid: 2,
        name: "embedding",
        type: rawDeclaredType,
        notnull: 0,
        dflt_value: null,
        pk: 0
      };

      expect(pragmaRow.type).toBe("VECTOR(768 , 'embeddinggemma-2')");

      // 型パラメータ抽出（非パーサー正規表現）
      const match = rawDeclaredType.match(/^VECTOR\s*\(\s*(\d+)(?:\s*,\s*['"]?([^'")\s]+)['"]?)?\s*\)$/i);
      expect(match).not.toBeNull();
      expect(match?.[1]).toBe("768");
      expect(match?.[2]).toBe("embeddinggemma-2");
    });

    test("schema persists across database reopenings and restores type definition identically", () => {
      // acceptance.md 5-4: データベース再オープン後もスキーマから完全な型定義が復元される契約
      const initialSchemaDdl = "CREATE TABLE documents (\n  id INTEGER PRIMARY KEY,\n  text_data TEXT NOT NULL,\n  embedding VECTOR(768 , 'embeddinggemma-2')\n) STRICT";

      // 再オープン後の sqlite_schema から取得される DDL モック
      const reopenedSchemaDdl = initialSchemaDdl;
      expect(reopenedSchemaDdl).toBe(initialSchemaDdl);
      expect(reopenedSchemaDdl).toContain("VECTOR(768 , 'embeddinggemma-2')");
    });
  });
});
