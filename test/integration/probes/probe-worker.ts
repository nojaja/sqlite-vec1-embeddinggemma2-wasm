import { Worker, MessageChannel } from "node:worker_threads";
import { readFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { createResponseBuffer, waitResponse } from "../../../src/bridge/protocol";
import { startLocalModelServer, type LocalModelServer } from "../local-model-server";

/**
 * 処理名: Worker段階待機
 * 処理概要: READYまたは終了応答を期限付きで待つ。
 * 実装理由: Worker起動不良で無期限待機しないため。
 * @param worker - 静的entryの推論Worker。
 * @param expected - 待機する応答種別。
 * @returns 応答の観測完了。
 */
function waitWorkerStage(worker: Worker, expected: string): Promise<void> {
  /**
   * 処理名: Worker通知監視登録
   * 処理概要: message/error/期限を一つのPromiseに束ねる。
   * 実装理由: 起動失敗を必ず親へ通知するため。
   * @param accept - 正常応答。
   * @param reject - 異常応答。
   */
  function watch(accept: () => void, reject: (failure: Error) => void): void {
    /**
     * 処理名: 監視解放
     * 処理概要: timerとlistenerを取り除く。
     * 実装理由: 段階ごとの監視を蓄積しないため。
     */
    function cleanup(): void { clearTimeout(deadline); worker.off("message", onMessage); worker.off("error", onError); }
    /**
     * 処理名: Worker異常通知
     * 処理概要: 固定エラーで待機を終了する。
     * 実装理由: 上流例外本文を親のログへ渡さないため。
     */
    function onError(): void { cleanup(); reject(new Error("INFERENCE_WORKER_FAILED")); }
    /**
     * 処理名: Worker message確認
     * 処理概要: 期待段階だけを成功と判定する。
     * 実装理由: 進捗messageをREADYと取り違えないため。
     * @param message - Worker応答。
      * @param message.kind - 制御応答の種別。
      * @param message.code - 非機密の固定失敗code。
     */
    function onMessage(message: { kind?: string; code?: string }): void {
      if (message.kind === "failed") {
        cleanup();
        const code = ["E_INPUT", "E_MODEL_CACHE_MISS", "E_ASSET_INTEGRITY", "E_INFERENCE"].includes(message.code ?? "") ? message.code : "E_WORKER";
        reject(Object.assign(new Error("INFERENCE_WORKER_FAILED"), { code }));
      }
      else if (message.kind === expected) { cleanup(); accept(); }
    }
    const deadline = setTimeout(onError, 600000);
    worker.on("message", onMessage);
    worker.once("error", onError);
  }
  return new Promise<void>(watch);
}

/**
 * 処理名: 実推論Worker検証
 * 処理概要: 静的WorkerとMessagePortとSABで実embeddingを取得する。
 * 実装理由: main threadでの単独推論をWorker接続成立と混同しないため。
 * @returns Worker終了までの検証完了。
 */
async function probeInferenceWorker(): Promise<void> {
  const manifestBytes = await readFile("manifests/embeddinggemma2-q4.json");
  const cacheDirectory = await mkdtemp(resolve(tmpdir(), "svw-worker-probe-"));
  let server: LocalModelServer | undefined;
  let worker: Worker | undefined;
  const channel = new MessageChannel();
  try {
    server = await startLocalModelServer();
    worker = new Worker(resolve("dist/workers/inference-node.js"));
    const ready = waitWorkerStage(worker, "ready");
    worker.postMessage({ kind: "initialize", backend: "wasm", generation: 1, cacheDirectory, network: "allow", baseUrl: server.baseUrl, manifestHash: createHash("sha256").update(manifestBytes).digest("hex"), manifest: JSON.parse(manifestBytes.toString("utf8")), inferencePort: channel.port2 }, [channel.port2]);
    await ready;
    const results = [];
    const operations = process.argv.includes("--image-first") ? ["image", "query"] : ["query", "image"];
    for (const operation of operations) {
      const responseBuffer = createResponseBuffer();
      const input = operation === "query" ? { text: "vector search" } : { bytes: Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64")), mime: "image/png" };
      const start = performance.now();
      channel.port1.postMessage({ protocolVersion: 1, jobId: "pot-1", requestId: results.length + 1, generation: 1, operation, input, responseBuffer });
      const result = waitResponse(responseBuffer, new SharedArrayBuffer(4), performance.now() + 180000);
      console.log(JSON.stringify({ stage: "worker-response", operation, errorId: result.errorId, bytes: result.payload.length }));
      assert.equal(result.errorId, 0);
      assert.equal(result.payload.length, 3072);
      results.push({ operation, bytes: result.payload.length, elapsedMs: Math.round(performance.now() - start) });
      console.log(JSON.stringify({ stage: "worker-embedding", operation, status: "passed" }));
    }
    const closed = waitWorkerStage(worker, "closed");
    worker.postMessage({ kind: "close" });
    await closed;
    await mkdir("artifacts/release-gates", { recursive: true });
    await writeFile("artifacts/release-gates/worker-report.json", JSON.stringify({ status: "passed", staticWorker: true, backend: "wasm", numThreads: 1, results }, null, 2) + "\n", "utf8");
  } finally {
    channel.port1.close(); channel.port2.close(); await worker?.terminate();
    try { await server?.close(); } finally { await rm(cacheDirectory, { recursive: true, force: true }); }
  }
}

/**
 * 処理名: Worker検証失敗通知
 * 処理概要: 固定エラーで非0終了する。
 * 実装理由: 生成Worker不足や実推論失敗を隠さないため。
 * @param failure - 検証失敗。
 */
function failWorkerProbe(failure: unknown): void {
  const code = typeof failure === "object" && failure !== null && "code" in failure ? String(failure.code) : "E_WORKER";
  console.error(JSON.stringify({ stage: "worker-validation", status: "failed", code }));
  process.exitCode = 1;
}

probeInferenceWorker().catch(failWorkerProbe);