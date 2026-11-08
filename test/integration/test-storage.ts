import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

/** 処理名: 公式保存gate。処理概要: 実file crash復旧とmetadata保護を有限実行する。実装理由: 旧WASI保存の成功を新VFSへ転記しないため。 */
function runOfficialStorageGate(): void {
  for (const name of ["test-official-node-vfs", "test-official-metadata"]) {
    const result = spawnSync(process.execPath, [resolve("scripts/run.ts"), name], { stdio: "inherit", timeout: 180000 });
    if (result.status !== 0) throw new Error("OFFICIAL_STORAGE_GATE_FAILED");
  }
}

try { runOfficialStorageGate(); }
catch { console.error("OFFICIAL_STORAGE_GATE_FAILED"); process.exitCode = 1; }