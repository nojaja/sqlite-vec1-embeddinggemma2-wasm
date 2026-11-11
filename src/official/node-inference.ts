import { Worker } from "node:worker_threads";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import { VectorError } from "../errors";
import type { OfficialInferenceSession } from "./types";
import type { ValidatedEmbeddingOptions } from "./options";
import { requestEmbedding } from "../workers/db";
import { MODEL_REPOSITORY, MODEL_REVISION } from "../runtime-assets/model-contract";

/**
 * 処理名: Node 推論セッション生成
 * 処理概要: バックグラウンド Worker スレッドを起動し、同期推論プロトコルとセッション制御を構築する。
 * 実装理由: メインスレッドの SQLite 実行をブロックすることなく、同期 UDF 内で Atomics 待機によるベクトル推論を可能にするため。
 * @param options - 検証済み埋め込みオプション。
 * @param packageRoot - パッケージルートディレクトリ。
 * @returns 構築済み OfficialInferenceSession。
 */
export async function createNodeInferenceSession(
  options: ValidatedEmbeddingOptions,
  packageRoot: string
): Promise<OfficialInferenceSession> {
  const workerPath = resolve(packageRoot, "dist/workers/inference-node.js");
  const manifestPath = resolve(packageRoot, "manifests/embeddinggemma2-q4.json");

  let manifest: { modelId: string; fingerprint: string };
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    manifest = {
      modelId: "google/embeddinggemma-2",
      fingerprint: "5e730f96377d880c7ca94c9ddc9cd5f600e5237e106f5e4dc7d9448140026ac7"
    };
  }

  const healthBuffer = new SharedArrayBuffer(4);
  const worker = new Worker(workerPath, {
    workerData: {
      kind: "initialize",
      backend: options.backend,
      network: options.model.network,
      modelBaseUrl: (options.model as { baseUrl?: string }).baseUrl,
      generation: 1,
      healthBuffer,
      cacheDirectory: options.model.cacheDirectory
    }
  });

  // READY 待機
  await new Promise<void>((res, rej) => {
    const timer = setTimeout(() => {
      worker.terminate();
      rej(new VectorError("E_TIMEOUT"));
    }, options.initTimeoutMs);

    const onMessage = (msg: unknown) => {
      const data = msg as { kind?: string; code?: string; error?: string };
      if (data?.kind === "ready") {
        clearTimeout(timer);
        worker.off("message", onMessage);
        worker.off("error", onError);
        res();
      } else if (data?.kind === "failed") {
        clearTimeout(timer);
        console.error("Worker reported failed:", data.error || data.code);
        worker.terminate();
        rej(new VectorError("E_INFERENCE"));
      }
    };

    const onError = (err: unknown) => {
      clearTimeout(timer);
      worker.terminate();
      rej(err instanceof VectorError ? err : new VectorError("E_INFERENCE"));
    };

    worker.on("message", onMessage);
    worker.on("error", onError);
  });

  let closed = false;
  const cancellationBuffer = new SharedArrayBuffer(4);
  let requestIdCounter = 1;

  return {
    infer: (req) => {
      if (closed) throw new VectorError("E_INFERENCE");
      const res = requestEmbedding(
        worker,
        {
          jobId: `node-${Date.now()}`,
          requestId: requestIdCounter++,
          generation: 1,
          operation: req.operation,
          body: req.body,
          title: req.title,
          bytes: req.bytes,
          mime: req.mime
        },
        cancellationBuffer,
        options.sqlTimeoutMs
      );
      return res;
    },
    close: async () => {
      if (closed) return;
      closed = true;
      try {
        worker.postMessage({ kind: "close" });
        await worker.terminate();
      } catch {
        // 無視
      }
    },
    identity: {
      modelId: "embeddinggemma-2",
      revision: MODEL_REVISION,
      fingerprint: manifest.fingerprint,
      profile: "embeddinggemma-2/q4/768",
      backend: options.backend,
      runtimeGeneration: 1
    },
    information: {
      ready: true,
      modelId: manifest.modelId,
      dtype: "q4",
      dimension: 768,
      backend: options.backend,
      fingerprint: manifest.fingerprint
    }
  };
}
