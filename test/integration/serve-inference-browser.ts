import { buildSync } from "esbuild";
import { spawn } from "node:child_process";

/**
 * 処理名: 手動Chrome推論server起動
 * 処理概要: browser検証moduleをbundleしheaded Chromeをbrowser closeまで保持する。
 * 実装理由: 自動timeoutとは分離して利用者がstageと最終reportを目視確認するため。
 */
function serveBrowserInference(): void {
  buildSync({ entryPoints: ["test/integration/probes/probe-browser.ts"], outfile: ".build/probe-browser-manual.js", bundle: true, packages: "external", platform: "node", format: "cjs", target: "node24" });
  const childArguments = [".build/probe-browser-manual.js", "--backend", "wasm", "--channel", "chrome", "--headed", "--manual"];
  if (process.argv.includes("--server-only")) childArguments.push("--server-only");
  const child = spawn(process.execPath, childArguments, { stdio: "inherit" });
  /**
   * 処理名: 手動runner起動失敗
   * 処理概要: 固定messageと非0終了を設定する。
   * 実装理由: OS error本文を出力へ複製しないため。
   */
  function onError(): void { console.error("Manual browser inference failed to start."); process.exitCode = 1; }
  /**
   * 処理名: 手動runner終了反映
   * 処理概要: browser probeの終了codeを親processへ反映する。
   * 実装理由: browser closeと異常終了を呼出元が判定できるようにするため。
   * @param code - 子process終了code。
   */
  function onClose(code: number | null): void { process.exitCode = code ?? 1; }
  /**
   * 処理名: 手動runner中断転送
   * 処理概要: 親のSIGINTをbrowser probeへ一度転送する。
   * 実装理由: serverとheaded browserをterminal中断でcleanupするため。
   */
  function onInterrupt(): void { child.kill("SIGINT"); }
  child.once("error", onError);
  child.once("close", onClose);
  process.once("SIGINT", onInterrupt);
}

serveBrowserInference();