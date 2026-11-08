import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { MODEL_REVISION } from "../../src/runtime-assets/model-contract";
import { E2eTimingRecorder } from "./e2e-timing";

/** 処理名: 公式sample E2E report。処理概要: model入力を含まない検索・保存結果を表す。実装理由: 本配布の所有Worker経路を受入判定するため。 */
interface OfficialSampleReport {
  status: string;
  backend: string;
  database: string;
  inserted: number;
  onlineRequests: number;
  offlineRequests: number;
  initialResults: Array<{ rowid: string; distance: number }>;
  reopenedResults: Array<{ rowid: string; distance: number }>;
  remainingRows: string;
  quickCheck: string;
  rollbackVerified: boolean;
}

/**
 * 処理名: 公式sample順位検証
 * 処理概要: 候補件数・有限距離・決定的順序を照合する。
 * 実装理由: process終了0だけで意味検索成功にしないため。
 * @param rows - 実modelによる検索結果。
 * @param count - 期待件数。
 */
function verifySampleRanking(rows: OfficialSampleReport["initialResults"], count: number): void {
  expect(rows).toHaveLength(count);
  expect(new Set(rows.map((row) => row.rowid)).size).toBe(count);
  for (const row of rows) expect(Number.isFinite(row.distance)).toBe(true);
  for (let index = 1; index < rows.length; index++) expect(rows[index - 1]!.distance).toBeLessThanOrEqual(rows[index]!.distance);
}

/**
 * 処理名: 公式SQL意味検索E2E
 * 処理概要: 本配布sampleの実所有Workerでtext/image・検索・rollback・offline再openを検証する。
 * 実装理由: 削除した独自Promise APIや別SQLiteへfallbackしないため。
 * @param backend - 明示するWasmまたはDirectML。
 * @returns E2E完了。
 */
export async function runBackendScenario(backend: "wasm" | "directml"): Promise<void> {
  const timing = new E2eTimingRecorder(`sql-semantic-search-${backend}`);
  await mkdir(".build", { recursive: true });
  const root = await mkdtemp(resolve(".build", `official-e2e-${backend}-`));
  const filename = resolve(root, "report.json");
  let passed = false;
  try {
    await timing.measure("official-owner-online-offline", async () => {
      const result = spawnSync(process.execPath, [resolve("dist/samples/node/index.js"), "--model-root", resolve("model/embeddinggemma-2-ONNX", MODEL_REVISION), "--workdir", resolve(root, "data"), "--report", filename, "--backend", backend], { stdio: "inherit", timeout: 840000 });
      expect(result.status).toBe(0);
    });
    const report = JSON.parse(await readFile(filename, "utf8")) as OfficialSampleReport;
    expect(report).toMatchObject({ status: "passed", backend, database: "node-file", inserted: 4, offlineRequests: 0, remainingRows: "3", quickCheck: "ok", rollbackVerified: true });
    expect(report.onlineRequests).toBe(11);
    verifySampleRanking(report.initialResults, 4);
    verifySampleRanking(report.reopenedResults, 3);
    expect(report.initialResults[0]?.rowid).toBe("1");
    expect(report.reopenedResults.some((row) => row.rowid === "3")).toBe(false);
    passed = true;
  } finally {
    await rm(root, { recursive: true, force: true });
    await timing.write(passed ? "passed" : "failed", { backend, comparisonScenario: "official-sql-semantic-search-v003", measuredAt: new Date().toISOString() });
  }
}