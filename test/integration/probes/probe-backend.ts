const backendPath = require("node:path") as typeof import("node:path");
const backendUrl = require("node:url") as typeof import("node:url");
const backendAssert: typeof import("node:assert/strict") = require("node:assert/strict");

/**
 * 処理名: Node Wasm backend検証
 * 処理概要: 固定上流backendがnativeなしでwasmを選択することを確認する。
 * 実装理由: device文字列の指定だけでNode Wasm対応と誤認しないため。
 * @returns backend検証の完了。
 */
async function probePortableBackend(): Promise<void> {
  const root = process.argv[2] ?? ".build/inference-upstream/node_modules/@huggingface/transformers";
  const location = backendUrl.pathToFileURL(backendPath.resolve(root, "src/backends/onnx.js")).href;
  const runtime = await import(location) as { deviceToExecutionProviders: (device: string) => string[] };
  backendAssert.deepEqual(runtime.deviceToExecutionProviders("wasm"), ["wasm"]);
  backendAssert.throws(runtime.deviceToExecutionProviders.bind(undefined, "cpu"));
  console.log(JSON.stringify({ stage: "portable-node-backend", providers: ["wasm"], status: "passed" }));
}

/**
 * 処理名: backend失敗通知
 * 処理概要: 外部例外本文を出さずに失敗種別を記録する。
 * 実装理由: runtime検証でも内部pathやtensorをログへ漏らさないため。
 * @param failure - importまたはbackend検証の例外。
 */
function reportBackendFailure(failure: unknown): void {
  const code = typeof failure === "object" && failure !== null && "code" in failure ? String(failure.code) : "E_BACKEND";
  console.error(JSON.stringify({ stage: "portable-node-backend", status: "failed", code }));
  process.exitCode = 1;
}

probePortableBackend().catch(reportBackendFailure);