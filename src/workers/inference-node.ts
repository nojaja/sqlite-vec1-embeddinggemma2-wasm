import { parentPort, workerData } from "node:worker_threads";
import { resolve } from "node:path";
import * as path from "node:path";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import * as os from "node:os";
import { pathToFileURL } from "node:url";
import { verifyDirectMlInstallation } from "../inference/backends/directml";
import { initializeInferenceEngine, warmupImageBytes } from "../inference/initialize";
import { prepareNodeModelCache } from "../sqlite/node-model-cache";
import { DirectMlModelCache } from "../inference/backends/directml-vision-graph";
import { handleInferenceRequest } from "./inference";
import { publishInferenceHealth, HEALTH_READY, HEALTH_FAILED, HEALTH_CLOSED } from "../bridge/inference-health";
import type { PortableRuntime, InferenceEngine } from "../inference/engine";

// DirectML 実行環境検証および external 参照保持のため静的参照
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import * as _ortNode from "onnxruntime-node";

/**
 * 処理名: Node 推論初期化オプション
 */
export interface NodeInferenceWorkerInitialization {
  kind?: "initialize";
  backend?: "wasm" | "directml";
  network?: "allow" | "offline";
  generation?: number;
  modelBaseUrl?: string;
  cacheDirectory?: string;
  cache?: object;
  inferencePort?: MessagePort;
  healthBuffer?: SharedArrayBuffer;
  manifest?: unknown;
  codecs?: import("../inference/image-codecs").ImageCodecBytes;
}

let engine: InferenceEngine | null = null;
let currentGeneration = 0;
let activeHealthBuffer: SharedArrayBuffer | undefined;
let isClosing = false;

/**
 * 処理名: Node 推論エンジン初期化
 * 処理概要: backend に応じて portable Wasm または DirectML バンドルをロードし、初期化とウォームアップを行う。
 * 実装理由: Node 環境で同期 Atomics ブリッジと推論パイプラインを結合するため。
 * @param init - 初期化パラメーター。
 * @returns 初期化完了した InferenceEngine。
 */
async function initializeNodeWorker(init: NodeInferenceWorkerInitialization): Promise<InferenceEngine> {
  const backend = init.backend ?? "wasm";
  currentGeneration = init.generation ?? 0;
  activeHealthBuffer = init.healthBuffer;

  let runtime: PortableRuntime;
  let cache = init.cache;

  if (backend === "directml") {
    verifyDirectMlInstallation();
    // DirectML バンドルを require
    const dmlRuntimePath = resolve("dist/vendor/transformers-directml-node.js");
    runtime = require(dmlRuntimePath) as PortableRuntime;
  } else {
    const portableRuntimePath = resolve("dist/vendor/transformers-portable-node.js");
    runtime = require(portableRuntimePath) as PortableRuntime;
  }

  if (!cache) {
    const manifestPath = resolve("manifests/embeddinggemma2-q4.json");
    let manifestData: { artifactSetHash: string; revision: string; assets: import("../runtime-assets/model-contract").ModelAssetDigest[] };
    let manifestHash: string;

    if (init.manifest && typeof init.manifest === "object") {
      manifestData = init.manifest as any;
      manifestHash = crypto.createHash("sha256").update(JSON.stringify(manifestData)).digest("hex");
    } else {
      const manifestBytes = fs.readFileSync(manifestPath);
      manifestData = JSON.parse(manifestBytes.toString("utf8"));
      manifestHash = crypto.createHash("sha256").update(manifestBytes).digest("hex");
    }

    let effectiveCacheDir = init.cacheDirectory;
    if (!effectiveCacheDir) {
      const localApp = process.env.LOCALAPPDATA;
      const xdg = process.env.XDG_CACHE_HOME;
      if (localApp) {
        effectiveCacheDir = path.join(localApp, "sqlite-vec1-embeddinggemma2-wasm", "model");
      } else if (xdg) {
        effectiveCacheDir = path.join(xdg, "sqlite-vec1-embeddinggemma2-wasm", "model");
      } else {
        effectiveCacheDir = path.join(os.homedir(), ".cache", "sqlite-vec1-embeddinggemma2-wasm", "model");
      }
    }

    // オフライン実行時、未キャッシュかつローカルにモデル資材が存在する場合は安全に初期シードする
    const readyFile = resolve(effectiveCacheDir, "sets", manifestData.artifactSetHash, "ready.json");
    if (!fs.existsSync(readyFile)) {
      const seedRoot = resolve("model", "embeddinggemma-2-ONNX", manifestData.revision);
      if (fs.existsSync(seedRoot)) {
        const filesDir = resolve(effectiveCacheDir, "sets", manifestData.artifactSetHash, "files");
        fs.mkdirSync(filesDir, { recursive: true });
        for (const asset of manifestData.assets) {
          const srcFile = resolve(seedRoot, (asset as any).source ?? path.basename(asset.path));
          const dstFile = resolve(filesDir, asset.path);
          fs.mkdirSync(path.dirname(dstFile), { recursive: true });
          if (fs.existsSync(srcFile) && !fs.existsSync(dstFile)) {
            fs.copyFileSync(srcFile, dstFile);
          }
        }
        fs.writeFileSync(readyFile, JSON.stringify({ status: "ready", timestamp: Date.now() }), "utf8");
      }
    }

    const preparedCache = await prepareNodeModelCache({
      cacheDirectory: init.cacheDirectory,
      network: init.network ?? "offline",
      baseUrl: init.modelBaseUrl,
      assets: manifestData.assets,
      artifactSetHash: manifestData.artifactSetHash,
      manifestHash
    });
    cache = backend === "directml" ? new DirectMlModelCache(preparedCache) : preparedCache;
  }

  let codecs = init.codecs;
  if (!codecs) {
    const jpegPath = resolve("dist/image/jpeg.wasm");
    const pngPath = resolve("dist/image/png.wasm");
    const resizePath = resolve("dist/image/resize.wasm");
    if (fs.existsSync(jpegPath) && fs.existsSync(pngPath) && fs.existsSync(resizePath)) {
      codecs = {
        jpeg: fs.readFileSync(jpegPath),
        png: fs.readFileSync(pngPath),
        resize: fs.readFileSync(resizePath)
      };
    }
  }

  const wasmUrl = pathToFileURL(resolve("dist/ort/ort-wasm-simd-threaded.jsep.wasm")).href;
  const factoryUrl = pathToFileURL(resolve("dist/ort/ort-wasm-simd-threaded.jsep.mjs")).href;

  const eng = await initializeInferenceEngine(runtime, {
    backend,
    graphOptimizationLevel: backend === "directml" ? "disabled" : undefined,
    cache,
    wasmUrl,
    factoryUrl,
    codecs,
    warmupImage: warmupImageBytes()
  });

  return eng;
}

/**
 * 処理名: ポートメッセージハンドラー登録
 * 処理概要: 推論要求を受け取り handleInferenceRequest を呼び出す。
 * @param port - メッセージ受信ポート。
 */
function attachInferencePort(port: { on(event: "message", listener: (msg: unknown) => void): void; onmessage?: ((e: MessageEvent<unknown>) => void) | null }): void {
  const handler = async (msg: unknown) => {
    if (isClosing || !engine) return;
    const data = (msg && typeof msg === "object" && "data" in msg) ? (msg as { data: unknown }).data : msg;
    const isFatal = await handleInferenceRequest(engine, data, currentGeneration);
    if (isFatal) {
      publishInferenceHealth(activeHealthBuffer, HEALTH_FAILED);
      if (parentPort) {
        parentPort.postMessage({ kind: "failed", code: "E_INFERENCE" });
      }
      await closeWorker();
    }
  };

  if (typeof port.on === "function") {
    port.on("message", handler);
  } else {
    port.onmessage = (e: MessageEvent<unknown>) => handler(e.data);
  }
}

/**
 * 処理名: ワーカー安全クローズ
 * 処理概要: リソース解放と CLOSED ヘルス公開を実行する。
 */
async function closeWorker(): Promise<void> {
  if (isClosing) return;
  isClosing = true;
  publishInferenceHealth(activeHealthBuffer, HEALTH_CLOSED);
  if (engine) {
    try {
      await engine.close();
    } catch {
      // 無視
    }
    engine = null;
  }
}

// 親ポートが存在する場合のリスナー設定
if (parentPort) {
  parentPort.on("message", async (msg: unknown) => {
    const message = msg as Record<string, unknown> | null;
    if (!message || typeof message !== "object") return;

    if (message.kind === "initialize") {
      try {
        const init = message as unknown as NodeInferenceWorkerInitialization;
        engine = await initializeNodeWorker(init);
        publishInferenceHealth(activeHealthBuffer, HEALTH_READY);

        const targetPort = init.inferencePort ?? parentPort!;
        attachInferencePort(targetPort as any);

        parentPort!.postMessage({
          type: "ready",
          kind: "ready",
          backend: init.backend ?? "wasm",
          numThreads: 1
        });
      } catch (err: unknown) {
        console.error("Worker initialize error:", err);
        publishInferenceHealth(activeHealthBuffer, HEALTH_FAILED);
        parentPort!.postMessage({
          type: "failed",
          kind: "failed",
          code: (err as { code?: string })?.code ?? "E_INFERENCE",
          error: (err as Error)?.stack ?? String(err)
        });
        await closeWorker();
      }
    } else if (message.kind === "close") {
      await closeWorker();
      parentPort!.postMessage({ kind: "closed" });
    }
  });

  // workerData による自動即時初期化
  if (workerData && typeof workerData === "object" && Object.keys(workerData).length > 0) {
    (async () => {
      try {
        const init = workerData as NodeInferenceWorkerInitialization;
        engine = await initializeNodeWorker(init);
        publishInferenceHealth(activeHealthBuffer, HEALTH_READY);

        const targetPort = init.inferencePort ?? parentPort!;
        attachInferencePort(targetPort as any);

        parentPort!.postMessage({
          type: "ready",
          kind: "ready",
          backend: init.backend ?? "wasm",
          numThreads: 1
        });
      } catch (err: unknown) {
        console.error("Worker initialize error:", err);
        publishInferenceHealth(activeHealthBuffer, HEALTH_FAILED);
        parentPort!.postMessage({
          type: "failed",
          kind: "failed",
          code: (err as { code?: string })?.code ?? "E_INFERENCE",
          error: (err as Error)?.stack ?? String(err)
        });
        await closeWorker();
      }
    })();
  }
}
