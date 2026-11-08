import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { MODEL_ASSET_FILES, MODEL_REVISION } from "../../../src/runtime-assets/model-contract";

const browserProbePlaywright = require("playwright-core") as typeof import("playwright-core");

const browserProbeModelRoot = resolve("model", "embeddinggemma-2-ONNX", MODEL_REVISION);
const browserProbeDistRoot = resolve("dist");

/**
 * 処理名: browser probe固定引数取得
 * 処理概要: `--name value`形式の引数をallowlistで検証する。
 * 実装理由: backendやbrowserを自動選択せず証跡を系列分離するため。
 * @param name - 引数名。
 * @param fallback - 未指定時の固定値。
 * @param allowed - 許可値。
 * @returns 検証済み引数値。
 */
function browserProbeArgument<T extends string>(name: string, fallback: T, allowed: readonly T[]): T {
  const index = process.argv.indexOf(`--${name}`);
  const value = index < 0 ? fallback : process.argv[index + 1];
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new Error("E_INPUT");
  return value as T;
}

const browserProbeBackend = browserProbeArgument("backend", "wasm", ["wasm", "webgpu"] as const);
const browserProbeChannel = browserProbeArgument("channel", "msedge", ["chrome", "msedge"] as const);
const browserProbeHeaded = process.argv.includes("--headed");
const browserProbeManual = process.argv.includes("--manual");
const browserProbeServerOnly = process.argv.includes("--server-only");

/**
 * 処理名: browser probe MIME判定
 * 処理概要: 配信対象の拡張子を固定Content-Typeへ対応付ける。
 * 実装理由: module Worker、Wasm、JSONをbrowserが正しく解釈するため。
 * @param filename - 配信するfile path。
 * @returns Content-Type。
 */
function browserProbeMime(filename: string): string {
  const extension = extname(filename);
  if (extension === ".mjs" || extension === ".js") return "text/javascript; charset=utf-8";
  if (extension === ".wasm") return "application/wasm";
  if (extension === ".json") return "application/json; charset=utf-8";
  return "application/octet-stream";
}

/**
 * 処理名: browser probe header設定
 * 処理概要: SABに必要な分離headerとsame-origin資材条件を設定する。
 * 実装理由: COOP/COEPなしの見かけ上のWorker成功を受入にしないため。
 * @param response - loopback HTTP応答。
 * @param contentType - 配信資材のMIME。
 */
function setBrowserProbeHeaders(response: ServerResponse, contentType: string): void {
  response.setHeader("Content-Type", contentType);
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
}

/**
 * 処理名: browser probe file配信
 * 処理概要: 検証済みroot内の通常fileをstreamで返す。
 * 実装理由: 大型modelをhost memoryへ全読込みせずpath traversalを拒否するため。
 * @param filename - root内へ解決済みfile path。
 * @param root - 許可root。
 * @param response - loopback HTTP応答。
 */
async function serveBrowserProbeFile(filename: string, root: string, response: ServerResponse): Promise<void> {
  const boundary = root.endsWith(sep) ? root : `${root}${sep}`;
  if (!filename.startsWith(boundary) || !existsSync(filename) || !(await stat(filename)).isFile()) {
    response.statusCode = 404;
    response.end();
    return;
  }
  setBrowserProbeHeaders(response, browserProbeMime(filename));
  createReadStream(filename).pipe(response);
}

/**
 * 処理名: browser probe page
 * 処理概要: browser Workerでquery/imageを実行し機械可読reportを公開する。
 * 実装理由: main thread単独推論をbrowser Worker受入へ読み替えないため。
 * @returns 固定HTML。
 */
function browserProbePage(): string {
  return `<!doctype html><meta charset="utf-8"><title>Browser inference probe</title><style>body{margin:0;background:#101418;color:#e8eef2;font:16px/1.5 Consolas,monospace}main{max-width:960px;margin:0 auto;padding:32px}h1{font:600 24px/1.2 Georgia,serif;letter-spacing:0}pre{min-height:320px;padding:20px;border:1px solid #3a4650;border-radius:6px;background:#182027;white-space:pre-wrap;overflow-wrap:anywhere}</style><main><h1>Browser inference probe</h1><pre id="status">starting</pre></main><script type="module">
const backend = ${JSON.stringify(browserProbeBackend)};
const report = {status:"running",stage:"start",crossOriginIsolated,backend,headed:${String(browserProbeHeaded)},gpuAvailable:typeof navigator.gpu !== "undefined",results:[]};
globalThis.__svwReport = report;
const statusElement = document.querySelector("#status");
const render = () => { statusElement.textContent = JSON.stringify(report, null, 2); };
const setStage = (stage) => { report.stage = stage; render(); console.log("SVW_STAGE:" + stage); };
render();
const waitMessage = (worker, expected, timeoutMs) => new Promise((resolve, reject) => {
  const deadline = setTimeout(() => { cleanup(); reject(new Error("E_TIMEOUT")); }, timeoutMs);
  const cleanup = () => { clearTimeout(deadline); worker.removeEventListener("message", onMessage); worker.removeEventListener("error", onError); };
  const onError = () => { cleanup(); reject(new Error("E_INFERENCE")); };
  const onMessage = (event) => { if (event.data?.kind === "progress") { report.workerStage = event.data.stage; console.log("SVW_STAGE:worker-" + event.data.stage); if (typeof event.data.gpuAvailable === "boolean") report.workerGpuAvailable = event.data.gpuAvailable; if (typeof event.data.failureClass === "string") report.failureClass = event.data.failureClass; if (Array.isArray(event.data.failureSignals)) report.failureSignals = event.data.failureSignals; if (typeof event.data.errorName === "string") report.errorName = event.data.errorName; if (typeof event.data.ortCode === "number" || typeof event.data.ortCode === "string") report.ortCode = event.data.ortCode; if (typeof event.data.bundleFrame === "string") report.bundleFrame = event.data.bundleFrame; if (typeof event.data.nonFunctionTarget === "string") report.nonFunctionTarget = event.data.nonFunctionTarget; render(); } else if (event.data?.kind === "failed") onError(); else if (event.data?.kind === expected) { cleanup(); resolve(event.data); } };
  worker.addEventListener("message", onMessage); worker.addEventListener("error", onError, {once:true});
});
const waitResponse = async (buffer, timeoutMs) => {
  const header = new Int32Array(buffer, 0, 8); const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) { const state = Atomics.load(header, 0); if (state === 2 || state === 3) return {state,length:header[1],errorId:header[2],dimension:header[3],version:header[4]}; await new Promise((resolve) => setTimeout(resolve, 20)); }
  throw new Error("E_TIMEOUT");
};
try {
  if (!crossOriginIsolated || typeof SharedArrayBuffer === "undefined") throw new Error("E_ENVIRONMENT");
  if (backend === "webgpu") {
    const adapter = await navigator.gpu?.requestAdapter(); report.adapterAvailable = adapter != null;
    if (adapter != null) { const device = await adapter.requestDevice(); report.deviceAvailable = device != null; device.destroy(); }
  }
  setStage("manifest");
  const manifest = await fetch("/manifest.json", {cache:"no-store",credentials:"omit"}).then((response) => response.json());
  setStage("worker-initialize");
  const worker = new Worker("/dist/workers/inference-browser.mjs", {type:"module",name:"inference-browser"});
  const channel = new MessageChannel();
  const ready = waitMessage(worker, "ready", 600000);
  worker.postMessage({kind:"initialize",generation:1,backend,network:"allow",modelBaseUrl:location.origin+"/models/fixed/",manifest,inferencePort:channel.port2}, [channel.port2]);
  const readyMessage = await ready; setStage("ready"); report.ready = {backend:readyMessage.backend,numThreads:readyMessage.numThreads,fingerprint:readyMessage.fingerprint};
  const operations = [
    {operation:"query",input:{text:"vector search"}},
    {operation:"image",input:{bytes:Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=="), (value) => value.charCodeAt(0)),mime:"image/png"}}
  ];
  for (let index = 0; index < operations.length; index += 1) {
    const responseBuffer = new SharedArrayBuffer(8192); new Int32Array(responseBuffer)[4] = 1; const started = performance.now(); const item = operations[index];
    setStage(item.operation);
    channel.port1.postMessage({protocolVersion:1,jobId:"browser-pot",requestId:index+1,generation:1,operation:item.operation,input:item.input,responseBuffer});
    const result = await waitResponse(responseBuffer, 300000);
    if (result.state !== 2 || result.length !== 3072 || result.errorId !== 0 || result.dimension !== 768 || result.version !== 1) throw new Error("E_PROTOCOL");
    report.results.push({operation:item.operation,bytes:result.length,elapsedMs:Math.round(performance.now()-started)}); render();
  }
  setStage("close");
  const closed = waitMessage(worker, "closed", 30000); worker.postMessage({kind:"close"}); await closed; channel.port1.close(); worker.terminate();
  report.status = "passed"; setStage("complete");
} catch { report.failedStage = report.stage; report.status = "failed"; report.code = "E_BROWSER_INFERENCE"; render(); }
</script>`;
}

/**
 * 処理名: 手動browser終了待機
 * 処理概要: Playwright browserのdisconnectをvoid Promiseへ変換する。
 * 実装理由: 利用者がChromeを閉じるまでloopback serverを維持するため。
 * @param browser - headed Chrome process。
 * @returns browser終了。
 */
function waitManualBrowserClose(browser: import("playwright-core").Browser): Promise<void> {
  /**
   * 処理名: browser終了監視登録
   * 処理概要: disconnected listenerを一度だけ登録する。
   * 実装理由: Playwright callback引数をPromise解決値へ渡さないため。
   * @param accept - Promise完了callback。
   */
  function watch(accept: () => void): void {
    /**
     * 処理名: browser終了通知
     * 処理概要: browser引数を公開せず待機を完了する。
     * 実装理由: 手動runnerがserver cleanupへ進むため。
     */
    function onDisconnected(): void { accept(); }
    browser.once("disconnected", onDisconnected);
  }
  return new Promise<void>(watch);
}

/**
 * 処理名: 外部Chrome server停止待機
 * 処理概要: SIGINTを受けるまでloopback serverを保持する。
 * 実装理由: Playwrightを起動せず既存Chrome profileからURLを開くため。
 * @returns terminal中断通知。
 */
function waitExternalServerStop(): Promise<void> {
  /**
   * 処理名: server停止監視登録
   * 処理概要: SIGINT listenerを一度だけ登録する。
   * 実装理由: terminal中断後にHTTP serverを正常closeするため。
   * @param accept - Promise完了callback。
   */
  function watch(accept: () => void): void {
    /**
     * 処理名: server停止通知
     * 処理概要: 待機Promiseを完了する。
     * 実装理由: server close処理へ制御を戻すため。
     */
    function onInterrupt(): void { accept(); }
    process.once("SIGINT", onInterrupt);
  }
  return new Promise<void>(watch);
}

/**
 * 処理名: loopback server close
 * 処理概要: HTTP server終了をPromiseで待つ。
 * 実装理由: port解放前にrunnerを終了しないため。
 * @param server - 稼働中HTTP server。
 * @returns port解放完了。
 */
function closeBrowserProbeServer(server: ReturnType<typeof createServer>): Promise<void> {
  /**
   * 処理名: server close実行
   * 処理概要: callback errorをPromiseへ変換する。
   * 実装理由: cleanup失敗を正常終了へ隠さないため。
   * @param accept - 正常終了callback。
   * @param reject - 異常終了callback。
   */
  function close(accept: () => void, reject: (failure: Error) => void): void {
    server.close((failure) => { if (failure === undefined) accept(); else reject(failure); });
  }
  return new Promise<void>(close);
}

/**
 * 処理名: browser実推論probe
 * 処理概要: offline Edgeでbrowser Workerのtext/image推論とcloseを検証する。
 * 実装理由: G02のbrowser Wasm CPU経路を実modelで確認するため。
 * @returns browserとserver解放までの完了。
 */
async function probeBrowserInference(): Promise<void> {
  const manifestBytes = await readFile("manifests/embeddinggemma2-q4.json");
  const modelFiles = new Map<string, string>(MODEL_ASSET_FILES.map((asset) => [asset.path, asset.source]));
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/") { setBrowserProbeHeaders(response, "text/html; charset=utf-8"); response.end(browserProbePage()); return; }
    if (url.pathname === "/manifest.json") { setBrowserProbeHeaders(response, "application/json; charset=utf-8"); response.end(manifestBytes); return; }
    if (url.pathname.startsWith("/dist/")) { void serveBrowserProbeFile(resolve(url.pathname.slice(1)), browserProbeDistRoot, response); return; }
    if (url.pathname.startsWith("/models/fixed/")) {
      const logical = decodeURIComponent(url.pathname.slice("/models/fixed/".length));
      const source = modelFiles.get(logical);
      if (source !== undefined) { void serveBrowserProbeFile(resolve(browserProbeModelRoot, source), browserProbeModelRoot, response); return; }
    }
    response.statusCode = 404; response.end();
  });
  await new Promise<void>((accept) => { server.listen(0, "127.0.0.1", accept); });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("E_ENVIRONMENT");
  const origin = `http://127.0.0.1:${address.port}`;
  if (browserProbeServerOnly) {
    console.log(JSON.stringify({ stage: "manual-browser-server", status: "ready", mode: "external", url: origin, backend: browserProbeBackend }));
    await waitExternalServerStop();
    await closeBrowserProbeServer(server);
    return;
  }
  const browser = await browserProbePlaywright.chromium.launch({ channel: browserProbeChannel, headless: !browserProbeHeaded });
  const browserVersion = browser.version();
  console.log(JSON.stringify({ stage: "browser-environment", channel: browserProbeChannel, version: browserVersion, backend: browserProbeBackend, headed: browserProbeHeaded }));
  try {
    const context = await browser.newContext({ serviceWorkers: "block" });
    await context.route("**/*", async (route: import("playwright-core").Route) => { if (new URL(route.request().url()).origin === origin) await route.continue(); else await route.abort("blockedbyclient"); });
    const page = await context.newPage();
    page.on("console", (message) => { const text = message.text(); if (/^SVW_STAGE:[a-z-]{1,40}$/.test(text)) console.log(JSON.stringify({ stage: "browser-progress", value: text.slice(10) })); });
    await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 30000 });
    if (browserProbeManual) {
      console.log(JSON.stringify({ stage: "manual-browser-server", status: "ready", url: origin, channel: browserProbeChannel, backend: browserProbeBackend }));
      await waitManualBrowserClose(browser);
      return;
    }
    await page.waitForFunction(() => (globalThis as unknown as { __svwReport?: { status?: string } }).__svwReport?.status !== "running", undefined, { timeout: 1080000 });
    const pageReport = await page.evaluate(() => (globalThis as unknown as { __svwReport: unknown }).__svwReport);
    const report = { channel: browserProbeChannel, browserVersion, ...pageReport as object };
    await mkdir("artifacts/release-gates", { recursive: true });
    await writeFile(`artifacts/release-gates/browser-${browserProbeChannel}-${browserProbeBackend}-report.json`, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(report));
    if ((report as { status?: string }).status !== "passed") throw new Error("E_BROWSER_INFERENCE");
  } finally {
    if (browser.isConnected()) await browser.close();
    await closeBrowserProbeServer(server);
  }
}

/**
 * 処理名: browser実推論失敗通知
 * 処理概要: 入力や外部例外本文を出さず固定codeで非0終了する。
 * 実装理由: browser consoleやmodel pathを公開logへ漏らさないため。
 */
function reportBrowserInferenceFailure(): void {
  console.error(JSON.stringify({ stage: "browser-inference", status: "failed", code: "E_BROWSER_INFERENCE" }));
  process.exitCode = 1;
}

probeBrowserInference().catch(reportBrowserInferenceFailure);