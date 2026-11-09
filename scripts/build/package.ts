const esbuild = require("esbuild");
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const rootDir = process.cwd();
const distDir = path.resolve(rootDir, "dist");

/**
 * 処理名: SHA-256計算
 * 処理概要: バッファまたは文字列のSHA-256ハッシュ値を16進数文字列で算出する。
 * 実装理由: 生成資材の整合性検証ハッシュを記録するため。
 * @param data - ハッシュ計算対象のバッファまたは文字列。
 * @returns 算出されたSHA-256の16進数文字列。
 */
function sha256Hex(data: Buffer | string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/**
 * 処理名: 全ファイル走査
 * 処理概要: 指定ディレクトリ配下の全ファイルパスを再帰的に収集する。
 * 実装理由: distディレクトリ内の全成果物リストを構築するため。
 * @param dir - 走査対象のディレクトリパス。
 * @returns 収集された全ファイルの絶対パス配列。
 */
function walk(dir: string): string[] {
  let results: string[] = [];
  const list = fs.readdirSync(dir);
  for (const file of list) {
    const fullPath = path.resolve(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      results = results.concat(walk(fullPath));
    } else {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * 処理名: パッケージビルド主処理
 * 処理概要: 推論ビルド、公式資材配置、各エントリポイントのバンドル、型定義配置、レポート生成を実行する。
 * 実装理由: 配布用パッケージ成果物を一括生成するため。
 * @returns 完了Promise。
 */
async function main(): Promise<void> {
  console.log("=== Starting product build ===");

  // 1. 推論ビルドを実行
  console.log("[1/5] Running inference build...");
  childProcess.execFileSync(process.execPath, ["--experimental-strip-types", "scripts/build/inference.ts"], { stdio: "inherit" });

  // 2. 公式 SQLite 資材を dist ルートへコピー
  console.log("[2/5] Copying official SQLite files to dist...");
  const sqliteFiles = [
    "sqlite3.wasm",
    "sqlite3-node.mjs",
    "sqlite3-bundler-friendly.mjs",
    "sqlite3.mjs",
    "sqlite3-opfs-async-proxy.js",
    "sqlite3-worker1.mjs",
    "sqlite3-worker1-bundler-friendly.mjs",
    "sqlite3-worker1-promiser.mjs"
  ];

  for (const f of sqliteFiles) {
    fs.copyFileSync(
      path.resolve(rootDir, "downloads/sqlite-official", f),
      path.resolve(distDir, f)
    );
  }

  // 公式資材に上流バグ修正パッチを適用
  childProcess.execFileSync("git", [
    "apply",
    "--unidiff-zero",
    "--ignore-space-change",
    "--ignore-whitespace",
    "--directory=dist",
    "patches/sqlite-official.patch"
  ], { stdio: "inherit" });

  // 3. 各エントリーポイントのバンドル
  console.log("[3/5] Bundling product entry points and samples...");
  fs.mkdirSync(path.resolve(distDir, "node"), { recursive: true });
  fs.mkdirSync(path.resolve(distDir, "browser"), { recursive: true });
  fs.mkdirSync(path.resolve(distDir, "workers"), { recursive: true });
  fs.mkdirSync(path.resolve(distDir, "samples/node"), { recursive: true });
  fs.mkdirSync(path.resolve(distDir, "samples/browser"), { recursive: true });
  fs.mkdirSync(path.resolve(distDir, "reports"), { recursive: true });

  const metafiles: (import("esbuild").Metafile | undefined)[] = [];

  const cjsNodeBanner = {
    js: "const __svw_import_meta_url = require('node:url').pathToFileURL(__filename).href;\nconst __svw_import_meta = { url: __svw_import_meta_url };"
  };
  const cjsNodeDefine = {
    "import.meta.url": "__svw_import_meta_url",
    "import.meta": "__svw_import_meta"
  };

  // 3.1 dist/index.bundle.js
  const r1 = await esbuild.build({
    entryPoints: ["src/index.ts"],
    outfile: path.resolve(distDir, "index.bundle.js"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    banner: cjsNodeBanner,
    define: cjsNodeDefine,
    metafile: true
  });
  metafiles.push(r1.metafile);

  // 3.2 dist/node/index.js (CJS)
  const r2 = await esbuild.build({
    entryPoints: ["src/index.ts"],
    outfile: path.resolve(distDir, "node/index.js"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    banner: cjsNodeBanner,
    define: cjsNodeDefine,
    metafile: true
  });
  metafiles.push(r2.metafile);

  // 3.3 dist/node/index.mjs (ESM)
  const r3 = await esbuild.build({
    entryPoints: ["src/index.ts"],
    outfile: path.resolve(distDir, "node/index.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    metafile: true
  });
  metafiles.push(r3.metafile);

  // 3.4 dist/browser/index.mjs (ESM)
  const r4 = await esbuild.build({
    entryPoints: ["src/index-browser.ts"],
    outfile: path.resolve(distDir, "browser/index.mjs"),
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    metafile: true
  });
  metafiles.push(r4.metafile);

  // 3.5 dist/workers/inference-node.js (CJS)
  const r5 = await esbuild.build({
    entryPoints: ["src/workers/inference-node.ts"],
    outfile: path.resolve(distDir, "workers/inference-node.js"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    external: ["onnxruntime-node"],
    banner: cjsNodeBanner,
    define: cjsNodeDefine,
    metafile: true
  });
  metafiles.push(r5.metafile);

  // 3.6 dist/workers/inference-browser.mjs (ESM)
  const r6 = await esbuild.build({
    entryPoints: ["src/workers/inference-browser.ts"],
    outfile: path.resolve(distDir, "workers/inference-browser.mjs"),
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    metafile: true
  });
  metafiles.push(r6.metafile);

  // 3.7 dist/samples/node/index.js (CJS)
  const r7 = await esbuild.build({
    entryPoints: ["samples/node/index.ts"],
    outfile: path.resolve(distDir, "samples/node/index.js"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    external: ["onnxruntime-node"],
    banner: cjsNodeBanner,
    define: cjsNodeDefine,
    metafile: true
  });
  metafiles.push(r7.metafile);

  // 3.8 dist/samples/browser/index.mjs (ESM)
  const r8 = await esbuild.build({
    entryPoints: ["samples/browser/index.ts"],
    outfile: path.resolve(distDir, "samples/browser/index.mjs"),
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    metafile: true
  });
  metafiles.push(r8.metafile);

  // 3.9 dist/samples/browser/owner.mjs (ESM)
  const r9 = await esbuild.build({
    entryPoints: ["samples/browser/owner.ts"],
    outfile: path.resolve(distDir, "samples/browser/owner.mjs"),
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    metafile: true
  });
  metafiles.push(r9.metafile);

  // 3.10 dist/samples/browser/server.js (CJS)
  const r10 = await esbuild.build({
    entryPoints: ["samples/browser/server.ts"],
    outfile: path.resolve(distDir, "samples/browser/server.js"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    metafile: true
  });
  metafiles.push(r10.metafile);

  // 4. 型定義ファイルの出力
  console.log("[4/5] Emitting TypeScript declaration files...");
  const typesContent = fs.readFileSync(path.resolve(rootDir, "src/official/types.ts"), "utf8");
  fs.mkdirSync(path.resolve(distDir, "official"), { recursive: true });
  fs.writeFileSync(path.resolve(distDir, "official/types.d.ts"), typesContent);

  const indexDts = [
    'import type { ProductInitOptions, ProductSqlite3 } from "./official/types";',
    'export default function initialize(options?: ProductInitOptions): Promise<ProductSqlite3>;',
    'export * from "./official/types";',
    ""
  ].join("\n");
  fs.writeFileSync(path.resolve(distDir, "index.d.ts"), indexDts);
  fs.writeFileSync(path.resolve(distDir, "index.d.mts"), indexDts);
  fs.writeFileSync(path.resolve(distDir, "index-browser.d.ts"), indexDts);

  // 5. レポートおよびロックファイルの生成
  console.log("[5/5] Generating reports and runtime-lock...");

  // 5.1 ランタイムロック (manifests/runtime-lock.json & dist/runtime-lock.json)
  const REQUIRED_RUNTIME_ASSETS = [
    "wabt-source",
    "sqlite-official-wasm",
    "sqlite-official-node-loader",
    "sqlite-official-browser-loader",
    "sqlite-official-esm-loader",
    "sqlite-official-proxy",
    "sqlite-official-worker1",
    "sqlite-official-bundler-worker1",
    "sqlite-official-promiser",
    "sqlite-wasm-package",
    "transformers-source",
    "onnxruntime-node-package",
    "onnxruntime-common-package",
    "ort-node-directml-dll",
    "ort-node-dxcompiler-dll",
    "ort-node-runtime-dll",
    "ort-node-binding",
    "ort-jsep-loader",
    "ort-jsep-wasm",
    "ort-jspi-loader",
    "ort-jspi-wasm",
    "jpeg-codec",
    "png-codec",
    "resize-codec"
  ];

  const portablePatch = fs.readFileSync(path.resolve(rootDir, "patches/transformers-portable.patch"));
  const directmlPatch = fs.readFileSync(path.resolve(rootDir, "patches/transformers-directml.patch"));
  const sqliteOfficialPatch = fs.readFileSync(path.resolve(rootDir, "patches/sqlite-official.patch"));

  const runtimeLock = {
    schemaVersion: 1,
    assets: REQUIRED_RUNTIME_ASSETS.map((name) => ({ name })),
    patches: {
      "patches/transformers-portable.patch": {
        bytes: portablePatch.length,
        sha256: sha256Hex(portablePatch)
      },
      "patches/transformers-directml.patch": {
        bytes: directmlPatch.length,
        sha256: sha256Hex(directmlPatch)
      },
      "patches/sqlite-official.patch": {
        bytes: sqliteOfficialPatch.length,
        sha256: sha256Hex(sqliteOfficialPatch)
      }
    },
    toolchain: {
      node: process.version,
      platform: process.platform,
      arch: process.arch
    }
  };
  const lockJson = JSON.stringify(runtimeLock, null, 2) + "\n";
  fs.mkdirSync(path.resolve(rootDir, "manifests"), { recursive: true });
  fs.writeFileSync(path.resolve(rootDir, "manifests/runtime-lock.json"), lockJson);
  fs.writeFileSync(path.resolve(distDir, "runtime-lock.json"), lockJson);

  // 5.2 esbuild-metafile.json
  const mergedInputs: Record<string, unknown> = {};
  const mergedOutputs: Record<string, unknown> = {};
  for (const m of metafiles) {
    if (m?.inputs) Object.assign(mergedInputs, m.inputs);
    if (m?.outputs) Object.assign(mergedOutputs, m.outputs);
  }
  fs.writeFileSync(
    path.resolve(distDir, "reports/esbuild-metafile.json"),
    JSON.stringify({ inputs: mergedInputs, outputs: mergedOutputs }, null, 2) + "\n"
  );

  // 5.3 build-content.json
  const allDistFiles = walk(distDir).map((f) => {
    const rel = path.relative(distDir, f).replace(/\\/g, "/");
    const buf = fs.readFileSync(f);
    return {
      path: `dist/${rel}`,
      bytes: buf.length,
      sha256: sha256Hex(buf)
    };
  });
  allDistFiles.sort((a, b) => a.path.localeCompare(b.path));
  fs.writeFileSync(
    path.resolve(distDir, "reports/build-content.json"),
    JSON.stringify({ schemaVersion: 1, files: allDistFiles }, null, 2) + "\n"
  );

  // 5.4 sbom.cdx.json (CycloneDX 1.6)
  const sbom = {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: {
      component: {
        name: "sqlite-vec1-embeddinggemma2-wasm",
        version: "0.0.3",
        type: "library"
      }
    },
    components: allDistFiles.map((f) => ({
      name: f.path,
      type: "file",
      hashes: [{ alg: "SHA-256", content: f.sha256 }]
    }))
  };
  fs.writeFileSync(
    path.resolve(distDir, "reports/sbom.cdx.json"),
    JSON.stringify(sbom, null, 2) + "\n"
  );

  console.log("=== Product build completed successfully ===");
}

main().catch((err) => {
  console.error("Product build failed:", err);
  process.exit(1);
});
