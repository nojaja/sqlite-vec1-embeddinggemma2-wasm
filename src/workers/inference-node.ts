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
import type { ImageCodecBytes } from "../inference/image-codecs";

// onnxruntime-nodeの明示参照（esbuild外部依存およびbundle検証をパスするため）
export const ORT_NODE_REFERENCE = ort;

/**
 * 処理名: 初期化メッセージインターフェース
 * 処理概要: 親スレッドから推論ワーカーへ送信される初期化パラメータの構造を定義する。
 * 実装理由: バックエンド、キャッシュ、マニフェスト、ポート情報を型安全に受け渡すため。
 */
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

/**
 * 処理名: 終了メッセージインターフェース
 * 処理概要: 親スレッドから推論ワーカーへ送信される終了要求メッセージを定義する。
 * 実装理由: セッション終了要求を明示的に識別するため。
 */
interface CloseMessage {
  kind: "close";
}

let currentEngine: InferenceEngine | undefined;
let currentPort: MessagePort | undefined;

/**
 * 処理名: 推論エンジンインスタンス構築
 * 処理概要: バックエンド種別に応じたランタイムとキャッシュを用いて推論エンジンを初期化する。
 * 実装理由: 初期化ハンドラの複雑度を低減するため。
 * @param message - 初期化メッセージ。
 * @param cache - 準備済みモデルキャッシュ。
 * @param codecs - 画像コーデック資材。
 * @returns 初期化された推論エンジン。
 */
async function buildEngine(
  message: InitializeMessage,
  cache: Awaited<ReturnType<typeof prepareNodeModelCache>>,
  codecs: ImageCodecBytes
): Promise<InferenceEngine> {
  if (message.backend === "directml") {
    // DirectML用ORTシンボルのグローバル登録
    const runtimeSymbol = Symbol.for("onnxruntime");
    (globalThis as unknown as Record<symbol, unknown>)[runtimeSymbol] = ort;

    const directmlVendorPath = resolve(__dirname, "../vendor/transformers-directml-node.js");
    const runtime = require(directmlVendorPath) as PortableRuntime;
    const dmlCache = new DirectMlModelCache(cache);
    return initializeInferenceEngine(runtime, {
      backend: "directml",
      cache: dmlCache,
      codecs,
      warmupImage: warmupImageBytes()
    });
  }
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
  return initializeInferenceEngine(runtime, {
    backend: "wasm",
    cache,
    codecs,
    wasmUrl,
    factoryUrl,
    warmupImage: warmupImageBytes()
  });
}

/**
 * 処理名: 初期化メッセージ処理
 * 処理概要: 受信した初期化メッセージを検証し推論エンジンとポート待受を構成する。
 * 実装理由: ワーカー初期化ライフサイクルを一元管理するため。
 * @param message - 初期化メッセージ。
 */
async function handleInit(message: InitializeMessage): Promise<void> {
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

    currentEngine = await buildEngine(message, cache, codecs);
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
}

/**
 * 処理名: 終了メッセージ処理
 * 処理概要: エンジンおよびポートをクローズしリソースを解放する。
 * 実装理由: ワーカー停止要求を安全に処理するため。
 */
async function handleClose(): Promise<void> {
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

if (parentPort !== null && parentPort !== undefined) {
  parentPort.on("message", async (message: InitializeMessage | CloseMessage) => {
    if (message.kind === "initialize") {
      await handleInit(message);
    } else if (message.kind === "close") {
      await handleClose();
    }
  });
}
