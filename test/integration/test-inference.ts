import { buildSync } from "esbuild";
import { spawnSync } from "node:child_process";

/**
 * 処理名: 実推論Worker受入
 * 処理概要: build済みWorkerを実モデルとSABで検証する。
 * 実装理由: unitや生成物存在確認を実推論の成功へ読み替えないため。
 */
function testRealInference(): void {
  buildSync({ entryPoints: ["test/integration/probes/probe-worker.ts"], outfile: ".build/probe-worker.js", bundle: true, packages: "external", platform: "node", format: "cjs", target: "node24" });
  const result = spawnSync(process.execPath, [".build/probe-worker.js"], { stdio: "inherit", timeout: 900000 });
  process.exitCode = result.status ?? 124;
}

testRealInference();