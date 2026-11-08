import { runBackendScenario } from "./sql-semantic-search-scenario";

/**
 * 処理名: CPU SQL意味検索E2E
 * 処理概要: 共通シナリオをWasm CPUで実行する。
 * 実装理由: GPUと同じ入力、SQL、assertion、計測区間を維持するため。
 * @returns E2E完了。
 */
async function runCpuScenario(): Promise<void> { await runBackendScenario("wasm"); }

test("G04 E2E: SQL UDF inserts text embeddings and finds semantically similar content", runCpuScenario, 900000);