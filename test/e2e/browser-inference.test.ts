import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { E2eTimingRecorder } from "./e2e-timing";

/**
 * 処理名: browser推論runner完了待機
 * 処理概要: build済み成果物を使うrunnerを起動し終了0だけを受理する。
 * 実装理由: 過去reportや成果物存在だけをG02 E2E成功にしないため。
 * @returns 子プロセスの正常完了。
 */
function runBrowserInference(): Promise<void> {
  const child = spawn(process.execPath, ["scripts/run.ts", "test-inference-browser", "--backend", "webgpu", "--channel", "msedge"], { stdio: "inherit" });
  /**
   * 処理名: 子プロセス監視
   * 処理概要: 起動errorまたは非0終了をE2E失敗へ変換する。
   * 実装理由: browser runnerの失敗をJest成功へ隠さないため。
   * @param accept - 正常終了callback。
   * @param reject - 異常終了callback。
   */
  function watch(accept: () => void, reject: (failure: Error) => void): void {
    /**
     * 処理名: browser runner起動失敗
     * 処理概要: 固定errorでE2Eを終了する。
     * 実装理由: OS error本文をtest結果へ複製しないため。
     */
    function onError(): void { reject(new Error("E_BROWSER_RUNNER")); }
    /**
     * 処理名: browser runner終了判定
     * 処理概要: 終了code 0だけを成功とする。
     * 実装理由: signal終了やtimeout codeを成功扱いにしないため。
     * @param code - 子プロセス終了code。
     */
    function onClose(code: number | null): void { if (code === 0) accept(); else reject(new Error("E_BROWSER_INFERENCE")); }
    child.once("error", onError);
    child.once("close", onClose);
  }
  return new Promise<void>(watch);
}

/**
 * 処理名: Browser timing付きE2E
 * 処理概要: runner全体時間を計測し既存reportのquery/image時間を統合する。
 * 実装理由: browser process起動と実推論時間を分離して観測するため。
 * @returns E2E完了。
 */
async function runTimedBrowserInference(): Promise<void> {
  const timing = new E2eTimingRecorder("browser-inference-webgpu");
  let passed = false;
  try {
    await timing.measure("browser-runner-total", runBrowserInference);
    const report = JSON.parse(await readFile("artifacts/release-gates/browser-msedge-webgpu-report.json", "utf8")) as { results?: Array<{ operation: string; elapsedMs: number }> };
    passed = true;
    await timing.write("passed", { backend: "webgpu", browserOperations: report.results ?? [] });
  } finally {
    if (!passed) await timing.write("failed", { backend: "webgpu" });
  }
}

test("G02 E2E: built Edge WebGPU Worker returns real query and image embeddings", runTimedBrowserInference);