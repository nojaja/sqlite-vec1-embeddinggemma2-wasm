import { Worker } from "node:worker_threads";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import { VectorError } from "../errors";
import type { OfficialInferenceSession } from "./types";
import type { ValidatedEmbeddingOptions } from "./options";
import { requestEmbedding } from "../workers/db";
import {
  MODEL_REPOSITORY,
  MODEL_REVISION,
  buildInlineModelManifest,
  validateModelManifest,
  type ModelManifest,
  type ModelManifestProfile
} from "../runtime-assets/model-contract";
import type { ModelConfigOptions, ValidatedEmbeddingOptions } from "./options";

/**
 * 処理名: Node 単一モデル設定解決
 * 処理概要: ModelConfigOptions またはパス文字列から Node 用マニフェストを解決する。
 * 実装理由: Node Worker へ複数モデルの設定を統一形式で伝播するため。
 * @param name - 登録モデル名。
 * @param entry - モデル設定またはパス文字列。
 * @param packageRoot - パッケージルート。
 * @returns 解決済みモデルエントリ。
 */
async function resolveSingleNodeModel(
  name: string,
  entry: ModelConfigOptions | string,
  packageRoot: string
): Promise<{ manifest: ModelManifest; modelBaseUrl?: string; network?: "allow" | "offline"; preload?: boolean }> {
  if (typeof entry === "string") {
    const raw = JSON.parse(await readFile(resolve(packageRoot, entry), "utf8"));
    validateModelManifest(raw, true);
    return { manifest: raw as ModelManifest };
  }
  if (entry.manifest) {
    validateModelManifest(entry.manifest, true);
    return {
      manifest: entry.manifest as unknown as ModelManifest,
      modelBaseUrl: entry.baseUrl,
      network: entry.network,
      preload: entry.preload
    };
  }
  if (entry.manifestUrl) {
    const raw = JSON.parse(await readFile(resolve(packageRoot, entry.manifestUrl), "utf8"));
    validateModelManifest(raw, true);
    return {
      manifest: raw as ModelManifest,
      modelBaseUrl: entry.baseUrl,
      network: entry.network,
      preload: entry.preload
    };
  }
  return {
    manifest: buildInlineModelManifest({
      modelId: name,
      repository: entry.repository,
      revision: entry.revision,
      dimension: entry.dimension,
      dtype: entry.dtype,
      vision: entry.vision,
      maxTokens: entry.maxTokens,
      normalize: entry.normalize,
      prefix: entry.prefix,
      assets: entry.assets
    }),
    modelBaseUrl: entry.baseUrl,
    network: entry.network,
    preload: entry.preload
  };
}

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
  const manifestPath = resolve(packageRoot, options.manifestUrl ?? "manifests/embeddinggemma2-q4.json");

  let defaultManifest: {
    modelId: string;
    revision?: string;
    fingerprint: string;
    profile?: ModelManifestProfile;
  };
  try {
    defaultManifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    defaultManifest = {
      modelId: "google/embeddinggemma-2",
      fingerprint: "5e730f96377d880c7ca94c9ddc9cd5f600e5237e106f5e4dc7d9448140026ac7"
    };
  }

  const resolvedModels: Record<string, { manifest: ModelManifest; modelBaseUrl?: string; network?: "allow" | "offline"; preload?: boolean }> = {};
  const modelInfos: Record<string, { dimension: number; dtype: string; loaded: boolean }> = {};
  if (options.models) {
    for (const [name, cfg] of Object.entries(options.models)) {
      const resolved = await resolveSingleNodeModel(name, cfg, packageRoot);
      resolvedModels[name] = resolved;
      modelInfos[name] = {
        dimension: resolved.manifest.profile?.dimension ?? 768,
        dtype: resolved.manifest.profile?.dtype ?? "q4",
        loaded: false
      };
    }
  }
  const defaultModelName = options.defaultModel ?? (options.models ? Object.keys(options.models)[0]! : "embeddinggemma-2");
  const manifest = resolvedModels[defaultModelName]?.manifest ?? defaultManifest;
  if (!modelInfos[defaultModelName]) {
    modelInfos[defaultModelName] = { dimension: manifest.profile?.dimension ?? 768, dtype: manifest.profile?.dtype ?? "q4", loaded: true };
  } else {
    modelInfos[defaultModelName]!.loaded = true;
  }

  const healthBuffer = new SharedArrayBuffer(4);
  const worker = new Worker(workerPath, {
    workerData: {
      kind: "initialize",
      backend: options.backend,
      network: options.model.network,
      modelBaseUrl: (options.model as { baseUrl?: string }).baseUrl,
      manifest: resolvedModels[defaultModelName]?.manifest,
      models: Object.keys(resolvedModels).length > 0 ? resolvedModels : undefined,
      defaultModel: defaultModelName,
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
          model: req.model,
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
        await new Promise<void>((res) => {
          const timer = setTimeout(() => {
            cleanup();
            res();
          }, 5000);
          timer.unref?.();

          const onMessage = (msg: unknown) => {
            if ((msg as { kind?: string } | null)?.kind === "closed") {
              cleanup();
              res();
            }
          };
          const onDone = () => {
            cleanup();
            res();
          };
          const cleanup = () => {
            clearTimeout(timer);
            worker.off("message", onMessage);
            worker.off("exit", onDone);
            worker.off("error", onDone);
          };

          worker.on("message", onMessage);
          worker.on("exit", onDone);
          worker.on("error", onDone);
          worker.postMessage({ kind: "close" });
        });
        await worker.terminate();
      } catch {
        // 無視
      }
    },
    identity: {
      modelId: manifest.modelId === "google/embeddinggemma-2" ? "embeddinggemma-2" : manifest.modelId,
      revision: manifest.revision ?? MODEL_REVISION,
      fingerprint: manifest.fingerprint,
      profile: `${manifest.modelId === "google/embeddinggemma-2" ? "embeddinggemma-2" : manifest.modelId}/${manifest.profile?.dtype ?? "q4"}/${manifest.profile?.dimension ?? 768}`,
      dimension: manifest.profile?.dimension ?? 768,
      dtype: manifest.profile?.dtype ?? "q4",
      backend: options.backend,
      runtimeGeneration: 1
    },
    information: {
      ready: true,
      modelId: manifest.modelId,
      dtype: manifest.profile?.dtype ?? "q4",
      dimension: manifest.profile?.dimension ?? 768,
      backend: options.backend,
      fingerprint: manifest.fingerprint,
      models: modelInfos
    }
  };
}
