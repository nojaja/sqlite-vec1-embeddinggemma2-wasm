import { Worker, MessageChannel } from "node:worker_threads";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import type { ReadyEmbeddingOptions } from "./options";
import type { OfficialInferenceSession } from "./types";
import { MODEL_ID, MODEL_REVISION, type ModelManifest } from "../runtime-assets/model-contract";
import { VectorError, type ErrorCode } from "../errors";
import { requestEmbedding } from "../workers/db";
import type { EmbeddingCall } from "./functions";

export async function createNodeInferenceSession(
  options: ReadyEmbeddingOptions,
  packageRoot: string
): Promise<OfficialInferenceSession> {
  const manifestPath = resolve(packageRoot, "manifests/embeddinggemma2-q4.json");
  let manifestBytes: Buffer;
  try {
    manifestBytes = await readFile(manifestPath);
  } catch {
    throw new VectorError("E_ASSET_INTEGRITY");
  }

  const manifestHash = createHash("sha256").update(manifestBytes).digest("hex");
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as ModelManifest;

  if (
    manifest.modelId !== MODEL_ID ||
    manifest.revision !== MODEL_REVISION ||
    typeof manifest.fingerprint !== "string"
  ) {
    throw new VectorError("E_ASSET_INTEGRITY");
  }

  if (options.backend === "directml") {
    // Windows x64 native verification
    if (process.platform !== "win32" || process.arch !== "x64") {
      throw new VectorError("E_ENVIRONMENT");
    }
    const bindingPath = resolve(
      packageRoot,
      "node_modules/onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime_binding.node"
    );
    try {
      const bindingBytes = await readFile(bindingPath);
      if (bindingBytes.length !== 358200) {
        throw new VectorError("E_ASSET_INTEGRITY");
      }
      const bindingHash = createHash("sha256").update(bindingBytes).digest("hex");
      if (bindingHash !== "8d9f996ff7dcc60c4899aa87aa7abe07d806f9c314882f44a001d0fd8a23d16f") {
        throw new VectorError("E_ASSET_INTEGRITY");
      }
    } catch (err) {
      if (err instanceof VectorError) throw err;
      throw new VectorError("E_ENVIRONMENT");
    }
  }

  const workerPath = resolve(packageRoot, "dist/workers/inference-node.js");
  const worker = new Worker(workerPath);
  const channel = new MessageChannel();

  let closed = false;

  const initPromise = new Promise<void>((resolveInit, rejectInit) => {
    let timeoutId: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
    };

    const onError = () => {
      cleanup();
      rejectInit(new VectorError("E_INFERENCE"));
    };

    const onExit = (code: number) => {
      cleanup();
      if (code !== 0) rejectInit(new VectorError("E_INFERENCE"));
    };

    const onMessage = (msg: any) => {
      if (msg?.kind === "ready") {
        cleanup();
        resolveInit();
      } else if (msg?.kind === "failed") {
        cleanup();
        const code = msg.code as ErrorCode;
        rejectInit(new VectorError(code ?? "E_INFERENCE"));
      }
    };

    timeoutId = setTimeout(() => {
      cleanup();
      rejectInit(new VectorError("E_TIMEOUT"));
    }, options.initTimeoutMs);

    worker.on("message", onMessage);
    worker.once("error", onError);
    worker.once("exit", onExit);
  });

  worker.postMessage(
    {
      kind: "initialize",
      backend: options.backend,
      generation: 1,
      cacheDirectory: options.cacheDirectory,
      network: options.model.network,
      baseUrl: options.model.baseUrl,
      manifestHash,
      manifest,
      inferencePort: channel.port2
    },
    [channel.port2]
  );

  await initPromise;

  let reqId = 0;
  const cancellationBuffer = new SharedArrayBuffer(4);

  const infer = (call: EmbeddingCall): Uint8Array | null => {
    if (closed) {
      throw new VectorError("E_ENVIRONMENT");
    }
    return requestEmbedding(
      channel.port1,
      {
        jobId: "sql",
        requestId: ++reqId,
        generation: 1,
        ...call
      },
      cancellationBuffer,
      options.sqlTimeoutMs
    );
  };

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    channel.port1.close();
    const closedPromise = new Promise<void>((res) => {
      const onMsg = (msg: any) => {
        if (msg?.kind === "closed") {
          worker.off("message", onMsg);
          res();
        }
      };
      worker.on("message", onMsg);
      worker.once("exit", () => res());
    });
    worker.postMessage({ kind: "close" });
    await Promise.race([closedPromise, new Promise((res) => setTimeout(res, 2000))]);
    await worker.terminate();
  };

  return {
    infer,
    identity: {
      modelId: MODEL_ID,
      revision: MODEL_REVISION,
      fingerprint: manifest.fingerprint,
      profile: "embeddinggemma-2/q4/768",
      backend: options.backend,
      runtimeGeneration: 1
    },
    information: { ready: true },
    close
  };
}
