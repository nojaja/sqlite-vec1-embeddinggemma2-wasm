const esbuild = require("esbuild") as typeof import("esbuild");
const childProcess = require("node:child_process") as typeof import("node:child_process");
const fs = require("node:fs") as typeof import("node:fs");
const path = require("node:path") as typeof import("node:path");

const rootDir = process.cwd();
const distVendor = path.resolve(rootDir, "dist/vendor");
const distOrt = path.resolve(rootDir, "dist/ort");
const distImage = path.resolve(rootDir, "dist/image");
const transformersSrc = path.resolve(rootDir, "node_modules/@huggingface/transformers");

/**
 * 処理名: 資材コピー
 * 処理概要: ORT Wasm/JSおよび画像codec Wasmをdistへ配置する。
 * 実装理由: ランタイムに必要なONNX Runtime関連ファイル群をdist配下に準備するため。
 */
function copyRuntimeAssets(): void {
  fs.mkdirSync(distOrt, { recursive: true });
  fs.mkdirSync(distImage, { recursive: true });

  const ortFiles = [
    "ort-wasm-simd-threaded.jsep.mjs",
    "ort-wasm-simd-threaded.jsep.wasm",
    "ort-wasm-simd-threaded.jspi.mjs",
    "ort-wasm-simd-threaded.jspi.wasm"
  ];
  for (const file of ortFiles) {
    fs.copyFileSync(path.resolve(rootDir, "node_modules/onnxruntime-web/dist", file), path.resolve(distOrt, file));
  }

  fs.copyFileSync(path.resolve(rootDir, "node_modules/@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm"), path.resolve(distImage, "jpeg.wasm"));
  fs.copyFileSync(path.resolve(rootDir, "node_modules/@jsquash/png/codec/pkg/squoosh_png_bg.wasm"), path.resolve(distImage, "png.wasm"));
  fs.copyFileSync(path.resolve(rootDir, "node_modules/@jsquash/resize/lib/resize/pkg/squoosh_resize_bg.wasm"), path.resolve(distImage, "resize.wasm"));
}

/**
 * 処理名: ブラウザ用Node built-in stubプラグイン
 * 処理概要: ブラウザバンドル時にNode固有モジュールをダミー実装へ置き換える。
 * 実装理由: ブラウザ環境でNode依存エラーが発生するのを防止するため。
 * @returns esbuildプラグインオブジェクト。
 */
function createNodeStubPlugin(): import("esbuild").Plugin {
  return {
    name: "node-stubs",
    /**
     * 処理名: プラグインセットアップ
     * 処理概要: esbuildの解決およびロードフックを登録する。
     * 実装理由: Nodeビルトインモジュールをスタブへ差し替えるため。
     * @param plugin - プラグインビルドコンテキスト。
     */
    setup(plugin) {
      plugin.onResolve({ filter: /^node:/ }, (args) => {
        return { path: args.path, namespace: "node-stub" };
      });
      plugin.onLoad({ filter: /.*/, namespace: "node-stub" }, () => {
        return {
          contents: "export default {}; export const Readable = class {}; export const pipeline = () => {}; export const promises = {};",
          loader: "js"
        };
      });
    }
  };
}

/**
 * 処理名: 上流画像プラグイン設定
 * 処理概要: Transformersのimage.jsを自前のimage.tsへ解決する。
 * 実装理由: バンドル時にカスタム画像処理実装へ解決を誘導するため。
 * @param stagingDir - ステージング作業ディレクトリのパス。
 * @returns esbuildプラグインオブジェクト。
 */
function createPortableImagePlugin(stagingDir: string): import("esbuild").Plugin {
  const upstreamImage = path.resolve(stagingDir, "src/utils/image.js");
  const replacement = path.resolve(rootDir, "src/inference/image.ts");
  return {
    name: "portable-image",
    /**
     * 処理名: プラグインセットアップ
     * 処理概要: 画像ユーティリティパスの解決フックを登録する。
     * 実装理由: Transformers内部の画像処理を自前実装に差し替えるため。
     * @param plugin - プラグインビルドコンテキスト。
     */
    setup(plugin) {
      plugin.onResolve({ filter: /image\.js$/ }, (args) => {
        if (path.resolve(args.resolveDir, args.path) === upstreamImage) {
          return { path: replacement };
        }
        return undefined;
      });
    }
  };
}

/**
 * 処理名: エントリソース生成
 * 処理概要: Transformersの公開モジュールをエクスポートするコード文字列を生成する。
 * 実装理由: バンドル用の仮想エントリポイントソースを動的に構築するため。
 * @param stagingDir - ステージング作業ディレクトリのパス。
 * @returns エントリソースコード文字列。
 */
function createEntry(stagingDir: string): string {
  const rel = stagingDir.replace(/\\/g, "/");
  return [
    `export {env} from "./${rel}/src/env.js";`,
    `export {AutoConfig} from "./${rel}/src/configs.js";`,
    `export {AutoModel} from "./${rel}/src/models/auto/modeling_auto.js";`,
    `export {AutoProcessor} from "./${rel}/src/models/auto/processing_auto.js";`,
    'export {decodeRawImage} from "./src/inference/image.ts";',
    'export {initializeImageCodecs} from "./src/inference/image-codecs.ts";'
  ].join("\n");
}

/**
 * 処理名: 安全な再帰削除
 * 処理概要: 指定パスのディレクトリやファイルをリトライ付きで強制削除する。
 * 実装理由: Windowsでのファイルロック競合によるビルド失敗を防ぐため。
 * @param targetPath - 削除対象のファイルまたはディレクトリパス。
 */
function safeRmSync(targetPath: string): void {
  for (let i = 0; i < 10; i++) {
    try {
      if (fs.existsSync(targetPath)) {
        fs.rmSync(targetPath, { recursive: true, force: true });
      }
      return;
    } catch {
      childProcess.spawnSync("cmd", ["/c", "ping", "127.0.0.1", "-n", "2"], { stdio: "ignore" });
    }
  }
}

/**
 * 処理名: 推論ビルド実行
 * 処理概要: Portable版およびDirectML版のTransformers推論パッケージをビルドする。
 * 実装理由: Node/Browser双方で利用可能な推論バイナリ成果物を生成するため。
 */
async function buildInference(): Promise<void> {
  fs.mkdirSync(distVendor, { recursive: true });
  copyRuntimeAssets();

  // 1. Portable bundle (Node CJS & Browser ESM)
  const portableStaging = path.resolve(rootDir, ".build/staging/transformers-portable");
  safeRmSync(portableStaging);
  fs.mkdirSync(portableStaging, { recursive: true });
  try {
    fs.cpSync(transformersSrc, portableStaging, { recursive: true });
    childProcess.execFileSync("git", ["apply", "--unidiff-zero", "--ignore-space-change", "--ignore-whitespace", `--directory=.build/staging/transformers-portable`, "patches/transformers-portable.patch"], { stdio: "inherit" });

    const entry = createEntry(".build/staging/transformers-portable");

    // Portable Node CJS
    await esbuild.build({
      stdin: { contents: entry, resolveDir: rootDir, loader: "ts" },
      outfile: path.resolve(distVendor, "transformers-portable-node.js"),
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node24",
      define: { "import.meta": "__svw_import_meta" },
      banner: { js: "const __svw_import_meta = {url: require('node:url').pathToFileURL(__filename).href};" },
      plugins: [createPortableImagePlugin(portableStaging)]
    });

    // Portable Browser ESM
    await esbuild.build({
      stdin: { contents: entry, resolveDir: rootDir, loader: "ts" },
      outfile: path.resolve(distVendor, "transformers-portable.mjs"),
      bundle: true,
      platform: "browser",
      format: "esm",
      target: "es2022",
      plugins: [createPortableImagePlugin(portableStaging), createNodeStubPlugin()]
    });
  } finally {
    safeRmSync(portableStaging);
  }

  // 2. DirectML bundle (Node CJS)
  const directmlStaging = path.resolve(rootDir, ".build/staging/transformers-directml");
  safeRmSync(directmlStaging);
  fs.mkdirSync(directmlStaging, { recursive: true });
  try {
    fs.cpSync(transformersSrc, directmlStaging, { recursive: true });
    childProcess.execFileSync("git", ["apply", "--unidiff-zero", "--ignore-space-change", "--ignore-whitespace", `--directory=.build/staging/transformers-directml`, "patches/transformers-directml.patch"], { stdio: "inherit" });

    const entry = createEntry(".build/staging/transformers-directml");
    await esbuild.build({
      stdin: { contents: entry, resolveDir: rootDir, loader: "ts" },
      outfile: path.resolve(distVendor, "transformers-directml-node.js"),
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node24",
      external: ["onnxruntime-node"],
      define: { "import.meta": "__svw_import_meta" },
      banner: { js: "const __svw_import_meta = {url: require('node:url').pathToFileURL(__filename).href};" },
      plugins: [createPortableImagePlugin(directmlStaging)]
    });
  } finally {
    safeRmSync(directmlStaging);
  }

  console.log("Inference build completed successfully.");
}

buildInference().catch((err) => {
  console.error("Inference build failed:", err);
  process.exit(1);
});
