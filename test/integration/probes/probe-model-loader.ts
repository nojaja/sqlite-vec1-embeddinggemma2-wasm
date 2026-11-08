const loaderPath = require("node:path") as typeof import("node:path");
const loaderUrl = require("node:url") as typeof import("node:url");
const loaderAssert: typeof import("node:assert/strict") = require("node:assert/strict");

/**
 * 処理名: external dataのbytes供給検証
 * 処理概要: 配置済み実graphと重みを上流loader経由で読む。
 * 実装理由: Node用path最適化をORT Webへ誤って渡さないため。
 * @returns 検証完了。
 */
async function probeModelLoader(): Promise<void> {
  const vendor = loaderPath.resolve(".build/inference-upstream/node_modules/@huggingface/transformers/src");
  const environment = await import(loaderUrl.pathToFileURL(loaderPath.join(vendor, "env.js")).href);
  environment.env.allowRemoteModels = false;
  environment.env.allowLocalModels = true;
  environment.env.useFS = true;
  environment.env.useFSCache = false;
  const loader = await import(loaderUrl.pathToFileURL(loaderPath.join(vendor, "utils/model-loader.js")).href);
  const root = loaderPath.resolve("model/embeddinggemma-2-ONNX/daa72c51243991dfcaf9f9137d2c573d8f7790c0");
  const options = { local_files_only: true, subfolder: "" };
  const graph: unknown = await loader.getCoreModelFile(root, "model", options, "_q4");
  loaderAssert.ok(graph instanceof Uint8Array, "Graph must be bytes, not a Node file path.");
  const external: unknown[] = await loader.getModelDataFiles(root, "model", "_q4", options, 1);
  loaderAssert.equal(external.length, 1);
  const data = external[0] as { path?: unknown; data?: unknown };
  loaderAssert.equal(data.path, "model_q4.onnx_data");
  loaderAssert.ok(data.data instanceof Uint8Array);
  console.log(JSON.stringify({ stage: "portable-model-loader", graphBytes: graph.byteLength, externalBytes: data.data.byteLength, status: "passed" }));
}

/**
 * 処理名: loader失敗通知
 * 処理概要: 固定messageで非0終了を報告する。
 * 実装理由: 上流例外の絶対pathを出力しないため。
 */
function reportLoaderFailure(): void {
  console.error("Portable model loader failed: expected graph bytes and named external data bytes.");
  process.exitCode = 1;
}

probeModelLoader().catch(reportLoaderFailure);