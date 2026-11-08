import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { sqliteWasmDemoCases, verifyDemoRows } from "../../tooling/quality/sqlite-wasm-compat";
import { buildWebpackDemo, buildParcelDemo, buildRsbuildDemo, serveSqliteDemo } from "../../tooling/quality/sqlite-demo-bundlers";

const compatibilitySource = "sqlite-wasm-ccbb81134a3b5a824f8a3cc3c5d8edd6e799ab5a";

/**
 * 処理名: 固定デモ展開
 * 処理概要: 対象archiveから未変更のデモを所有する一時領域へ展開する。
 * 実装理由: 固定上流を直接検証し、他runの作業領域を変更しないため。
 * @param directory - 今回所有する一時領域。
 * @returns 展開済みデモroot。
 */
async function extractCompatibilityDemos(directory: string): Promise<string> {
  const archive = resolve("downloads", compatibilitySource + ".tar.gz");
  const result = spawnSync("tar", ["-xf", archive, "-C", directory, "--strip-components=1", compatibilitySource + "/demos", compatibilitySource + "/tsconfig.json"], { encoding: "utf8", timeout: 30000 });
  if (result.status !== 0) throw new Error("SQLITE_WASM_DEMO_ARCHIVE_INVALID");
  return join(directory, "demos");
}

/**
 * 処理名: Vite公式デモ検証
 * 処理概要: アプリを変更せずpackage aliasだけで同一buildのmoduleへ置換する。
 * 実装理由: SQLやconstructorの書換えで互換成功を装わないため。
 * @param browser - 検証browser。
 * @param root - 固定デモのroot。
 * @param name - デモ名。
 * @param expected - 固定上流の行表示。
 * @param loader - 完成入力のbrowser loader。
 * @returns 受入済みデモの診断。
 */
async function verifyViteDemo(browser: Browser, root: string, name: string, expected: readonly string[], loader: string): Promise<{ name: string; status: string; externalRequests: number }> {
  const { createServer } = await import("vite");
  const server = await createServer({
    configFile: false, root: join(root, name), logLevel: "error",
    resolve: { alias: { "@sqlite.org/sqlite-wasm": loader } },
    optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm"] },
    server: { host: "127.0.0.1", port: 0, fs: { allow: [process.cwd()] }, headers: { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" } }
  });
  const context = await browser.newContext({ serviceWorkers: "block" });
  let externalRequests = 0;
  try {
    await server.listen();
    const address = server.httpServer?.address();
    if (address === null || address === undefined || typeof address === "string") throw new Error("SQLITE_WASM_DEMO_SERVER_UNAVAILABLE");
    const origin = `http://127.0.0.1:${address.port}`;
    await context.route("**/*", (route) => {
      if (route.request().url().startsWith(origin + "/")) return route.continue();
      externalRequests++;
      return route.abort();
    });
    const page = await context.newPage();
    await page.goto(origin);
    await page.waitForFunction((count) => document.querySelectorAll("#app li").length >= count, expected.length, { timeout: 30000 });
    verifyDemoRows(await page.locator("#app li").allTextContents(), expected);
    if (externalRequests !== 0) throw new Error("SQLITE_WASM_DEMO_EXTERNAL_REQUEST");
    return { name, status: "passed", externalRequests };
  } finally {
    await context.close();
    await server.close();
  }
}

/**
 * 処理名: webpack実出力検証
 * 処理概要: 固定デモから生成したbundleを実browserで開く。
 * 実装理由: Viteだけの成功を全bundler互換へ読み替えないため。
 * @param browser - 検証browser。
 * @param root - 固定デモroot。
 * @param name - デモ名。
 * @param expected - 固定上流の期待表示。
 * @param loader - 完成browser loader。
 * @returns 受入済みデモの診断。
 */
async function verifyWebpackDemo(browser: Browser, root: string, name: string, expected: readonly string[], loader: string): Promise<{ name: string; status: string; externalRequests: number }> {
  const builders: Record<string, typeof buildWebpackDemo> = { "sahpool-webpack-demo": buildWebpackDemo, "sahpool-parcel-demo": buildParcelDemo, "sahpool-rsbuild-demo": buildRsbuildDemo };
  const build = builders[name];
  if (build === undefined) throw new Error("SQLITE_WASM_DEMO_BUNDLER_UNKNOWN");
  const directory = await build(join(root, name), loader);
  const { server, origin } = await serveSqliteDemo(directory);
  const context = await browser.newContext({ serviceWorkers: "block" });
  let externalRequests = 0;
  try {
    await context.route("**/*", (route) => { if (route.request().url().startsWith(origin + "/")) return route.continue(); externalRequests++; return route.abort(); });
    const page = await context.newPage();
    page.on("console", (message) => { if (message.type() === "error") console.error("SQLITE_WASM_DEMO_BROWSER_ERROR", message.text()); });
    page.on("pageerror", (failure) => console.error("SQLITE_WASM_DEMO_PAGE_ERROR", failure.message));
    await page.goto(origin);
    await page.waitForFunction((count) => document.querySelectorAll("#app li").length >= count, expected.length, { timeout: 30000 });
    verifyDemoRows(await page.locator("#app li").allTextContents(), expected);
    if (externalRequests !== 0) throw new Error("SQLITE_WASM_DEMO_EXTERNAL_REQUEST");
    return { name, status: "passed", externalRequests };
  } finally {
    await context.close();
    await new Promise<void>((complete, reject) => server.close((failure) => failure ? reject(failure) : complete()));
  }
}

/**
 * 処理名: 公式互換gate
 * 処理概要: 固定上流デモを実Edgeで検証し、完了後だけreportを作る。
 * 実装理由: 製品受入をmockや別SQLiteの成功で代替しないため。
 * @returns 今回gateの完了。
 */
async function testSqliteWasmCompatibility(): Promise<void> {
  const loader = resolve("dist/browser/index.mjs");
  await access(loader);
  const selected = sqliteWasmDemoCases.filter((candidate) => process.argv[2] === undefined || candidate.name === process.argv[2]);
  if (selected.length === 0) throw new Error("SQLITE_WASM_DEMO_UNKNOWN");
  await mkdir(".build", { recursive: true });
  const temporary = await mkdtemp(resolve(".build/sqlite-wasm-compat-"));
  let browser: Browser | undefined;
  try {
    const root = await extractCompatibilityDemos(temporary);
    browser = await chromium.launch({ channel: "msedge", headless: true });
    const demos = [];
    for (const demo of selected) {
      const verify = demo.bundler === "vite" ? verifyViteDemo : verifyWebpackDemo;
      demos.push(await verify(browser, root, demo.name, demo.rows, loader));
    }
    let upstreamSmokePassed = false;
    if (demos.length === 9) {
      const smoke = spawnSync(process.execPath, [resolve("scripts/run.ts"), "test-upstream-sqlite-smoke"], { stdio: "inherit", timeout: 180000 });
      if (smoke.status !== 0) throw new Error("UPSTREAM_SQLITE_SMOKE_FAILED");
      upstreamSmokePassed = true;
    }
    const report = { schemaVersion: 1, stage: "sqlite-wasm-compat", source: compatibilitySource, browser: browser.version(), demos, allNineAccepted: demos.length === 9, upstreamSmokePassed };
    await mkdir("artifacts/release-gates", { recursive: true });
    await writeFile("artifacts/release-gates/sqlite-wasm-compat.json", JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report));
  } finally {
    await browser?.close();
    await rm(temporary, { recursive: true, force: true });
  }
}

testSqliteWasmCompatibility().catch((failure: unknown) => { console.error(failure); process.exitCode = 1; });