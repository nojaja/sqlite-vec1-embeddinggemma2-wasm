/**
 * 処理名: SQLite Wasm互換性検証ケース定義
 * 処理概要: SQLite Wasm公式デモケースの定義と結果照合機能を提供する。
 * 実装理由: 公式デモとの互換性を網羅的に検証するため。
 */

export interface SqliteWasmDemoCase {
  name: string;
  bundler: "vite" | "webpack";
  rows: readonly string[];
}

export const sqliteWasmDemoCases: SqliteWasmDemoCase[] = [
  { name: "sahpool-webpack-demo", bundler: "webpack", rows: ["1", "2"] },
  { name: "sahpool-parcel-demo", bundler: "webpack", rows: ["1", "2"] },
  { name: "sahpool-rsbuild-demo", bundler: "webpack", rows: ["1", "2"] },
  { name: "sahpool-vite-demo-1", bundler: "vite", rows: ["1", "2"] },
  { name: "sahpool-vite-demo-2", bundler: "vite", rows: ["1", "2"] },
  { name: "sahpool-vite-demo-3", bundler: "vite", rows: ["1", "2"] },
  { name: "sahpool-vite-demo-4", bundler: "vite", rows: ["1", "2"] },
  { name: "sahpool-vite-demo-5", bundler: "vite", rows: ["1", "2"] },
  { name: "sahpool-vite-demo-6", bundler: "vite", rows: ["1", "2"] }
];

/**
 * 処理名: デモ出力行検証
 * 処理概要: 実際の出力行と期待値行が長さ・順序・値ともに完全一致するか検証する。
 * 実装理由: 互換性出力が期待値と異なる場合に厳密に例外を発生させるため。
 * @param actual - 実際の出力行配列。
 * @param expected - 期待される出力行配列。
 */
export function verifyDemoRows(actual: readonly string[], expected: readonly string[]): void {
  if (actual.length !== expected.length) {
    throw new Error("SQLITE_WASM_DEMO_RESULT_MISMATCH");
  }
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] !== expected[i]) {
      throw new Error("SQLITE_WASM_DEMO_RESULT_MISMATCH");
    }
  }
}
