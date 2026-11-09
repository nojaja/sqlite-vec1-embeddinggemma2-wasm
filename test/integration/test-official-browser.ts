import { createReadStream } from "node:fs";
import { mkdir, writeFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve, relative, isAbsolute, extname } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { MODEL_ASSET_FILES, MODEL_REVISION } from "../../src/runtime-assets/model-contract";

/** 処理名: browser試験資材解決。処理概要: 固定modelとpackage資材だけへURLを対応付ける。実装理由: 試験serverから任意fileを公開しないため。
 * @param pathname - loopback request path。
 * @returns 許可されたrootと相対file。
 */
function officialBrowserAsset(pathname: string): { root: string; file: string } | undefined {
  if (pathname.startsWith("/models/fixed/")) {
    const asset = MODEL_ASSET_FILES.find((candidate) => pathname === "/models/fixed/" + candidate.path);
    return asset ? { root: resolve("model/embeddinggemma-2-ONNX", MODEL_REVISION), file: asset.source } : undefined;
  }
  const roots: Record<string, string> = { "/sqlite/": "downloads/sqlite-official", "/dist/": "dist", "/manifests/": "manifests" };
  const prefix = Object.keys(roots).find((candidate) => pathname.startsWith(candidate));
  return prefix ? { root: resolve(roots[prefix]!), file: pathname.slice(prefix.length) } : undefined;
}

/**
 * 処理名: 公式browser実推論gate
 * 処理概要: 固定資材だけを配信しonlineとfresh Worker offlineを検証する。
 * 実装理由: 外部サービスや旧SQL Workerを新公式APIの代用にしないため。
 * @returns browser受入完了。
 */
async function testOfficialBrowser(): Promise<void> {
  const backend = process.argv[2] ?? "wasm";
  if (backend !== "wasm" && backend !== "webgpu") throw new Error("E_INPUT");
  const compiled = await build({ entryPoints: ["test/integration/probes/official-browser-owner.ts"], bundle: true, platform: "browser", format: "esm", write: false });
  const owner = compiled.outputFiles[0]?.contents;
  if (owner === undefined) throw new Error("OFFICIAL_BROWSER_OWNER_MISSING");
  let modelRequests = 0;
  const server = createServer((request, response) => {
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin"); response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
    if (pathname === "/") { response.setHeader("Content-Type", "text/html"); response.end("<!doctype html><title>Official SQLite</title>"); return; }
    if (pathname === "/owner.mjs") { response.setHeader("Content-Type", "text/javascript"); response.end(owner); return; }
    const asset = officialBrowserAsset(pathname);
    if (asset === undefined) { response.writeHead(404); response.end(); return; }
    const { root, file } = asset;
    if (pathname.startsWith("/models/fixed/")) modelRequests++;
    const filename = resolve(root, file);
    const boundary = relative(root, filename);
    if (boundary.startsWith("..") || isAbsolute(boundary)) { response.writeHead(404); response.end(); return; }
    const mime = extname(filename) === ".wasm" ? "application/wasm" : extname(filename) === ".json" ? "application/json" : "text/javascript";
    response.setHeader("Content-Type", mime);
    stat(filename).then(() => createReadStream(filename).pipe(response)).catch(() => { response.writeHead(404); response.end(); });
  });
  await new Promise<void>((complete) => server.listen(0, "127.0.0.1", complete));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("OFFICIAL_BROWSER_SERVER_FAILED");
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  try {
    const context = await browser.newContext({ serviceWorkers: "block" });
    await context.route("**/*", (route) => route.request().url().startsWith(origin + "/") ? route.continue() : route.abort());
    const page = await context.newPage();
    await page.goto(origin);
    await page.evaluate(async () => {
      const module = await import(location.origin + "/dist/index-browser.mjs") as { sqlite3Worker1Promiser: () => Promise<(kind: string, arguments_: Record<string, unknown>) => Promise<{ result: { resultRows?: unknown[] } }>> };
      const OriginalWorker = Worker;
      let owner: Worker | undefined;
      globalThis.Worker = class extends OriginalWorker {
        /** 処理名: Worker1所有捕捉。処理概要: 元のWorker生成を維持し終了用参照だけを記録する。実装理由: default Worker URLを実行して資源を回収するため。
         * @param url - default Worker URL。
         * @param options - 公式Worker条件。
         */
        constructor(url: string | URL, options?: WorkerOptions) { super(url, options); owner = this; }
      };
      try {
        const promiser = await module.sqlite3Worker1Promiser();
        await promiser("open", { filename: ":memory:" });
        const result = await promiser("exec", { sql: "SELECT sqlite_version(),embedding(NULL)", rowMode: "array", resultRows: [] });
        if (JSON.stringify(result.result.resultRows) !== JSON.stringify([["3.54.1", null]])) throw new Error("OFFICIAL_WORKER1_RESULT_FAILED");
        await promiser("close", {});
      } finally { owner?.terminate(); globalThis.Worker = OriginalWorker; }
    });
    const reports = [];
    for (const network of ["allow", "offline"] as const) {
      modelRequests = 0;
      const result: { status: string; backend: string } = await page.evaluate(({ network, backend }) => new Promise<{ status: string; backend: string }>((complete, reject) => {
        const worker = new Worker("/owner.mjs", { type: "module" });
        const timer = setTimeout(() => { worker.terminate(); reject(new Error("OFFICIAL_BROWSER_TIMEOUT")); }, 600000);
        /** 処理名: 所有Worker結果受付。処理概要: 期限とWorkerを回収して結果を返す。実装理由: 完了後の資源を残さないため。
         * @param event - 固定試験結果。
         */
        worker.onmessage = (event) => { clearTimeout(timer); worker.terminate(); complete(event.data as { status: string; backend: string }); };
        /** 処理名: 所有Worker異常受付。処理概要: 固定失敗へ変換して回収する。実装理由: 内部例外をreportへ転記しないため。 */
        worker.onerror = () => { clearTimeout(timer); worker.terminate(); reject(new Error("OFFICIAL_BROWSER_WORKER_FAILED")); };
        worker.postMessage({ backend, network });
      }), { network, backend });
      if (result.status !== "passed" || result.backend !== backend || (network === "offline" && modelRequests !== 0)) throw new Error("OFFICIAL_BROWSER_ACCEPTANCE_FAILED");
      reports.push({ network, ...result, modelRequests });
    }
    await mkdir("artifacts/release-gates", { recursive: true });
    await writeFile(`artifacts/release-gates/official-browser-${backend}.json`, JSON.stringify({ status: "passed", browser: browser.version(), reports }, null, 2) + "\n");
    console.log(JSON.stringify({ stage: "official-browser-model", status: "passed", reports }));
  } finally { await browser.close(); await new Promise<void>((complete) => server.close(() => complete())); }
}

testOfficialBrowser().catch((failure: unknown) => { console.error(failure); process.exitCode = 1; });