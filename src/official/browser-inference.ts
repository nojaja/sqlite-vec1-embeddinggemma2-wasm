import { VectorError } from "../errors";
import { assertInferenceReady } from "../bridge/inference-health";
import { isSecureBrowserUrl } from "../runtime-assets/browser-model";
import {
  MODEL_ID,
  MODEL_REPOSITORY,
  MODEL_REVISION,
  validateModelAssets,
  type ModelAssetDigest
} from "../runtime-assets/model-contract";
import { requestEmbedding, type InferenceRequestPort } from "../workers/db";
import type { ValidatedEmbeddingOptions } from "./options";
import type { OfficialInferenceSession } from "./types";

/**
 * 処理名: ブラウザ公式資材 URL 群
 * 処理概要: 推論ワーカー、マニフェスト、モデル配置先の解決済み絶対 URL を保持する。
 * 実装理由: ブラウザ初期化時にパッケージ内資材および CDN モデル先を一貫して参照するため。
 */
export interface OfficialBrowserAssets {
  worker: string;
  dbWorker: string;
  manifest: string;
  modelBase: string;
}

/**
 * 処理名: ブラウザ資材 URL 解決オプション
 * 処理概要: モデルベース URL、ワーカー URL、DB ワーカー URL、マニフェスト URL の任意上書き指定を受け取る。
 * 実装理由: バンドラー環境や CDN 配信において柔軟に資材 URL を指定可能にするため。
 */
export interface BrowserAssetResolveOptions {
  modelBaseUrl?: string;
  workerUrl?: string;
  dbWorkerUrl?: string;
  manifestUrl?: string;
}

/**
 * 処理名: ブラウザモデルマニフェスト型
 * 処理概要: マニフェスト JSON の必須ヘッダおよび 11 資材定義を保持する。
 * 実装理由: ブラウザ Worker への初期化ペイロード構築と完全性検証のため。
 */
interface BrowserManifest {
  modelId: string;
  repository: string;
  revision: string;
  artifactSetHash: string;
  fingerprint: string;
  assets: ModelAssetDigest[];
}

const DEFAULT_BROWSER_MODEL_BASE_URL = `https://huggingface.co/${MODEL_REPOSITORY}/resolve/${MODEL_REVISION}/`;

/**
 * 処理名: 安全ブラウザ URL 解決
 * 処理概要: 相対または絶対 URL を基準 URL に対して解決し、安全性と末尾スラッシュを検証する。
 * 実装理由: 認証情報・クエリ・非 HTTPS などの危険な URL を事前排除するため。
 * @param rawUrl - 解決対象 URL 文字列。
 * @param baseUrl - 相対解決の基準 URL。
 * @param requireTrailingSlash - 末尾スラッシュを必須とするかどうか。
 * @returns 解決・検証済みの絶対 URL 文字列。
 */
function resolveSecureUrl(
  rawUrl: string,
  baseUrl: URL,
  requireTrailingSlash: boolean
): string {
  if (requireTrailingSlash && !rawUrl.endsWith("/")) {
    throw new VectorError("E_ASSET_INTEGRITY");
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl, baseUrl);
  } catch {
    throw new VectorError("E_ASSET_INTEGRITY");
  }
  if (!isSecureBrowserUrl(parsed)) {
    throw new VectorError("E_ASSET_INTEGRITY");
  }
  return parsed.href;
}

/**
 * 処理名: 公式ブラウザ資材 URL 解決
 * 処理概要: entry URL からパッケージルートを導出し、推論ワーカー、マニフェスト、モデル配置先の絶対 URL を解決する。
 * 実装理由: ドキュメントの URL やバンドラー配置に依存せず、外部 CDN や明示 URL も含めて安全に資材を解決するため。
 * @param entryUrl - ブラウザエントリの URL。
 * @param optionsOrModelRoot - 資材解決オプションまたはモデル配置先 URL (省略時は既定 CDN URL)。
 * @returns 解決済み資材 URL 群。
 */
export function resolveOfficialBrowserAssets(
  entryUrl: string,
  optionsOrModelRoot?: string | BrowserAssetResolveOptions
): OfficialBrowserAssets {
  let entryParsed: URL;
  try {
    entryParsed = new URL(entryUrl);
  } catch {
    throw new VectorError("E_ASSET_INTEGRITY");
  }

  const opts: BrowserAssetResolveOptions =
    typeof optionsOrModelRoot === "string"
      ? { modelBaseUrl: optionsOrModelRoot }
      : (optionsOrModelRoot ?? {});

  const packageRoot = new URL("../", entryParsed);
  if (!packageRoot.href.endsWith("/")) {
    packageRoot.href += "/";
  }

  const worker =
    opts.workerUrl !== undefined
      ? resolveSecureUrl(opts.workerUrl, entryParsed, false)
      : new URL("dist/workers/inference-browser.mjs", packageRoot).href;

  const dbWorker =
    opts.dbWorkerUrl !== undefined
      ? resolveSecureUrl(opts.dbWorkerUrl, entryParsed, false)
      : new URL("dist/workers/db-browser.mjs", packageRoot).href;

  const manifest =
    opts.manifestUrl !== undefined
      ? resolveSecureUrl(opts.manifestUrl, entryParsed, false)
      : new URL("manifests/embeddinggemma2-q4.json", packageRoot).href;

  const modelBase =
    opts.modelBaseUrl !== undefined
      ? resolveSecureUrl(opts.modelBaseUrl, entryParsed, true)
      : DEFAULT_BROWSER_MODEL_BASE_URL;

  return {
    worker,
    dbWorker,
    manifest,
    modelBase
  };
}

/**
 * 処理名: ブラウザマニフェスト取得検証
 * 処理概要: マニフェスト JSON を fetch し、ヘッダ項目および必須 11 資材の完全性を検証する。
 * 実装理由: 不正または破損したマニフェストで推論ワーカーを起動させないため。
 * @param manifestUrl - マニフェストの絶対 URL。
 * @returns 検証済み BrowserManifest。
 */
async function loadBrowserManifest(manifestUrl: string): Promise<BrowserManifest> {
  let res: Response;
  try {
    res = await fetch(manifestUrl, { cache: "no-store", credentials: "omit" });
  } catch {
    throw new VectorError("E_ASSET_INTEGRITY");
  }
  if (!res.ok) {
    throw new VectorError("E_ASSET_INTEGRITY");
  }

  let data: Partial<BrowserManifest>;
  try {
    data = (await res.json()) as Partial<BrowserManifest>;
  } catch {
    throw new VectorError("E_ASSET_INTEGRITY");
  }

  if (
    !data ||
    data.modelId !== MODEL_ID ||
    data.repository !== MODEL_REPOSITORY ||
    data.revision !== MODEL_REVISION ||
    typeof data.artifactSetHash !== "string" ||
    typeof data.fingerprint !== "string" ||
    !Array.isArray(data.assets)
  ) {
    throw new VectorError("E_ASSET_INTEGRITY");
  }

  validateModelAssets(data.assets);
  return data as BrowserManifest;
}

/**
 * 処理名: ブラウザ Worker 起動待機
 * 処理概要: 推論ワーカーからの ready/failed 通知またはタイムアウトを待機する。
 * 実装理由: モデルロードと warm-up が完了する前に SQLite UDF へセッションを公開しないため。
 * @param worker - 起動済み Web Worker インスタンス。
 * @param initTimeoutMs - 初期化タイムアウト時間 (ミリ秒)。
 * @returns 準備完了時に resolve する Promise。
 */
function awaitBrowserWorkerReady(worker: Worker, initTimeoutMs: number): Promise<void> {
  return new Promise<void>((res, rej) => {
    /**
     * 処理名: 待機イベント解除
     * 処理概要: タイマーと Worker イベントリスナーを解除する。
     * 実装理由: 完了・失敗・タイムアウト時のリソースリークを防ぐため。
     */
    const cleanup = () => {
      clearTimeout(timer);
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
    };

    const timer = setTimeout(() => {
      cleanup();
      worker.terminate();
      rej(new VectorError("E_TIMEOUT"));
    }, initTimeoutMs);

    /**
     * 処理名: Worker メッセージ受信ハンドラ
     * 処理概要: ready または failed 通知を判定して Promise を解決・拒否する。
     * 実装理由: 初期化成否を確実に親コンテキストへ伝播するため。
     * @param event - MessageEvent。
     */
    const onMessage = (event: MessageEvent<unknown>) => {
      const data = event.data as { kind?: string };
      if (data?.kind === "ready") {
        cleanup();
        res();
      } else if (data?.kind === "failed") {
        cleanup();
        worker.terminate();
        rej(new VectorError("E_INFERENCE"));
      }
    };

    /**
     * 処理名: Worker エラー受信ハンドラ
     * 処理概要: 起動中エラーを捕捉して Worker を終了し E_INFERENCE で拒否する。
     * 実装理由: 未処理エラーによるハングを防ぐため。
     */
    const onError = () => {
      cleanup();
      worker.terminate();
      rej(new VectorError("E_INFERENCE"));
    };

    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
  });
}

/**
 * 処理名: ブラウザ推論セッション生成
 * 処理概要: ブラウザ推論ワーカーを起動し、CDN/OPFS モデルキャッシュ準備と同期ブリッジを接続したセッションを構築する。
 * 実装理由: ブラウザ単体でオンデマンド CDN 取得・OPFS 永続キャッシュ・高速ベクトル検索を完結させるため。
 * @param options - 検証済み埋め込みオプション。
 * @param entryUrl - パッケージエントリの URL。
 * @returns 構築済み OfficialInferenceSession。
 */
export async function createBrowserInferenceSession(
  options: ValidatedEmbeddingOptions,
  entryUrl: string
): Promise<OfficialInferenceSession> {
  if (
    typeof SharedArrayBuffer === "undefined" ||
    typeof Worker === "undefined" ||
    typeof MessageChannel === "undefined"
  ) {
    throw new VectorError("E_ENVIRONMENT");
  }

  const assets = resolveOfficialBrowserAssets(entryUrl, {
    modelBaseUrl: options.model.baseUrl,
    workerUrl: options.workerUrl,
    manifestUrl: options.manifestUrl
  });
  const manifest = await loadBrowserManifest(assets.manifest);

  const healthBuffer = new SharedArrayBuffer(4);
  const cancellationBuffer = new SharedArrayBuffer(4);
  const channel = new MessageChannel();
  const worker = new Worker(assets.worker, { type: "module" });

  worker.postMessage(
    {
      kind: "initialize",
      generation: 1,
      backend: options.backend,
      network: options.model.network,
      modelBaseUrl: assets.modelBase,
      manifest,
      inferencePort: channel.port2,
      healthBuffer
    },
    [channel.port2]
  );

  await awaitBrowserWorkerReady(worker, options.initTimeoutMs);

  let closed = false;
  let requestIdCounter = 1;

  return {
    /**
     * 処理名: ブラウザ同期推論実行
     * 処理概要: ヘルス状態確認後、MessageChannel と SAB を用いて Worker へ同期推論要求を送信する。
     * 実装理由: SQLite UDF から同期的にベクトル推論結果を取得するため。
     * @param req - 推論リクエスト。
     * @returns 3072 バイトの Float32 BLOB または null。
     */
    infer(req) {
      if (closed) {
        throw new VectorError("E_INFERENCE");
      }
      assertInferenceReady(healthBuffer);
      try {
        return requestEmbedding(
          channel.port1 as unknown as InferenceRequestPort,
          {
            jobId: `browser-${Date.now()}`,
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
      } catch (err: unknown) {
        if (err instanceof TypeError) {
          throw new VectorError("E_ENVIRONMENT");
        }
        throw err;
      }
    },
    /**
     * 処理名: ブラウザ推論セッション終了
     * 処理概要: Worker へ close 通知を送信し、MessagePort と Worker を終了する。
     * 実装理由: セッション終了時にバックグラウンドリソースを確実に解放するため。
     * @returns 終了完了 Promise。
     */
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      try {
        worker.postMessage({ kind: "close" });
        channel.port1.close();
        worker.terminate();
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
