import { runBackendScenario } from "./sql-semantic-search-scenario";

/**
 * 処理名: GPU SQL意味検索E2E
 * 処理概要: 共通シナリオをDirectML GPUで実行する。
 * 実装理由: CPUと同じ入力、SQL、assertion、計測区間を維持するため。
 * @returns E2E完了。
 */
async function runGpuScenario(): Promise<void> { await runBackendScenario("directml"); }

test("G10-DML: SQL semantic search runs on explicit DirectML", runGpuScenario, 900000);