import { parentPort, type MessagePort } from "node:worker_threads";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as ort from "onnxruntime-node";
import { handleInferenceRequest } from "./inference";
import { prepareNodeModelCache } from "../sqlite/node-model-cache";
import { initializeInferenceEngine, warmupImageBytes } from "../inference/initialize";
import { MODEL_ID, MODEL_REPOSITORY, MODEL_REVISION, type ModelManifest } from "../runtime-assets/model-contract";
import { VectorError } from "../errors";
import type { InferenceEngine, PortableRuntime } from "../inference/engine";
import { DirectMlModelCache } from "../inference/backends/directml-vision-graph";

// onnxruntime-nodeの明示参照（esbuild外部依存およびbundle検証をパスするため）
export const ORT_NODE_REFERENCE = ort;

interface InitializeMessage {
  kind: "initialize";
  backend: "wasm" | "directml";
  generation: number;
  cacheDirectory?: string;
  network: "allow" | "offline";
  baseUrl: string;
  manifestHash: string;
  manifest: ModelManifest;
  inferencePort: MessagePort;
}

interface CloseMessage {
  kind: "close";
}

let currentEngine: InferenceEngine | undefined;
let currentPort: MessagePort | undefined;

if (parentPort !== null && parentPort !== undefined) {
  parentPort.on("message", async (message: InitializeMessage | CloseMessage) => {
    if (message.kind === "initialize") {
      try {
        if (!Number.isSafeInteger(message.generation) || message.generation < 0) {
          throw new VectorError("E_PROTOCOL");
        }
        const manifest = message.manifest;
        if (
          manifest.modelId !== MODEL_ID ||
          manifest.repository !== MODEL_REPOSITORY ||
          manifest.revision !== MODEL_REVISION
        ) {
          throw new VectorError("E_ASSET_INTEGRITY");
        }

        const cacheOptions = {
          network: message.network,
          baseUrl: message.baseUrl,
          assets: manifest.assets,
          artifactSetHash: manifest.artifactSetHash,
          manifestHash: message.manifestHash,
          ...(message.cacheDirectory !== undefined ? { cacheDirectory: message.cacheDirectory } : {})
        };
        const cache = await prepareNodeModelCache(cacheOptions);

        const imageDir = resolve(__dirname, "../image");
        const codecs = {
          jpeg: await readFile(resolve(imageDir, "jpeg.wasm")),
          png: await readFile(resolve(imageDir, "png.wasm")),
          resize: await readFile(resolve(imageDir, "resize.wasm"))
        };

        if (message.backend === "directml") {
          // DirectML用ORTシンボルのグローバル登録
          const runtimeSymbol = Symbol.for("onnxruntime");
          (globalThis as unknown as Record<symbol, unknown>)[runtimeSymbol] = ort;

          const directmlVendorPath = resolve(__dirname, "../vendor/transformers-directml-node.js");
          const runtime = require(directmlVendorPath) as PortableRuntime;
          const dmlCache = new DirectMlModelCache(cache);
          currentEngine = await initializeInferenceEngine(runtime, {
            backend: "directml",
            cache: dmlCache,
            codecs,
            warmupImage: warmupImageBytes()
          });
        } else {
          const portableVendorPath = resolve(__dirname, "../vendor/transformers-portable-node.js");
          const runtime = require(portableVendorPath) as PortableRuntime;
          const ortDir = resolve(__dirname, "../ort");
          const wasmUrl = pathToFileURL(resolve(ortDir, "ort-wasm-simd-threaded.jsep.wasm")).href;
          const factoryUrl = pathToFileURL(resolve(ortDir, "ort-wasm-simd-threaded.jsep.mjs")).href;
          if (!runtime.env.backends.onnx.wasm) {
            runtime.env.backends.onnx.wasm = {};
          }
          Object.assign(runtime.env.backends.onnx.wasm, {
            numThreads: 1,
            proxy: false,
            wasmPaths: { wasm: wasmUrl, mjs: factoryUrl }
          });
          currentEngine = await initializeInferenceEngine(runtime, {
            backend: "wasm",
            cache,
            codecs,
            wasmUrl,
            factoryUrl,
            warmupImage: warmupImageBytes()
          });
        }

        currentPort = message.inferencePort;

        currentPort.on("message", async (reqMessage: unknown) => {
          if (currentEngine !== undefined) {
            await handleInferenceRequest(currentEngine, reqMessage, message.generation);
          }
        });

        parentPort?.postMessage({ kind: "ready" });
      } catch (err) {
        console.error("DEBUG WORKER INIT ERROR:", err);
        const code = (err as { code?: string } | null)?.code ?? "E_INFERENCE";
        parentPort?.postMessage({ kind: "failed", code });
      }
    } else if (message.kind === "close") {
      try {
        if (currentEngine !== undefined) {
          await currentEngine.close();
          currentEngine = undefined;
        }
        if (currentPort !== undefined) {
          currentPort.close();
          currentPort = undefined;
        }
      } finally {
        parentPort?.postMessage({ kind: "closed" });
      }
    }
  });
}
