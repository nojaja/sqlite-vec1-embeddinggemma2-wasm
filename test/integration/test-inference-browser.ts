import { buildSync } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

/**
 * 処理名: browser probe引数取得
 * 処理概要: backend/channelの固定値をrunner report用に取得する。
 * 実装理由: timeout時も系列を混同しない機械可読証跡を残すため。
 * @param name - 引数名。
 * @param fallback - 未指定時の固定値。
 * @returns CLI値またはfallback。
 */
function browserProbeArgument(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1] ?? fallback;
}

/**
 * 処理名: browser実推論受入runner
 * 処理概要: browser検証moduleを一時bundleし同じNodeで有限実行する。
 * 実装理由: CommonJS rootでTypeScript ESMを直接起動せずG02を再現するため。
 */
function testBrowserInference(): void {
  buildSync({ entryPoints: ["test/integration/probes/probe-browser.ts"], outfile: ".build/probe-browser.js", bundle: true, packages: "external", platform: "node", format: "cjs", target: "node24" });
  const result = spawnSync(process.execPath, [".build/probe-browser.js", ...process.argv.slice(2)], { stdio: "inherit", timeout: 1200000 });
  if (result.status === null) {
    const backend = browserProbeArgument("backend", "wasm");
    const channel = browserProbeArgument("channel", "msedge");
    const report = { channel, backend, status: "failed", stage: "runner-timeout", timeoutMs: 1200000, code: "E_TIMEOUT" };
    mkdirSync("artifacts/release-gates", { recursive: true });
    writeFileSync(`artifacts/release-gates/browser-${channel}-${backend}-report.json`, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.error(JSON.stringify(report));
  }
  process.exitCode = result.status ?? 124;
}

testBrowserInference();