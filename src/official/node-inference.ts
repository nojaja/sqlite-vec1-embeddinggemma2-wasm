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

/**
 * 処理名: マニフェスト読み込みおよび検証
 * 処理概要: マニフェストファイルを読み込み、モデルID・リビジョン・ハッシュを検証する。
 * 実装理由: 不正または改ざんされたモデル資材での初期化を防ぐため。
 * @param packageRoot - パッケージルートパス。
 * @returns マニフェストオブジェクトとSHA-256ハッシュ。
 */
async function loadManifest(packageRoot: string): Promise<{ manifest: ModelManifest; manifestHash: string }> {
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
  return { manifest, manifestHash };
}

/**
 * 処理名: DirectMLネイティブバインディング検証
 * 処理概要: Windows環境およびonnxruntime-nodeバイナリのサイズとハッシュを検証する。
 * 実装理由: DirectML実行環境の整合性を保証するため。
 * @param packageRoot - パッケージルートパス。
 */
async function verifyDirectMlBinding(packageRoot: string): Promise<void> {
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

/**
 * 処理名: ワーカーレディ待機
 * 処理概要: 推論ワーカーからの初期化完了メッセージまたはエラーをタイムアウト付きで待機する。
 * 実装理由: ワーカー起動の成否を確実に検知するため。
 * @param worker - 対象ワーカーインスタンス。
 * @param initTimeoutMs - 初期化タイムアウト時間(ms)。
 */
async function waitForWorkerReady(worker: Worker, initTimeoutMs: number): Promise<void> {
  return new Promise<void>((resolveInit, rejectInit) => {
    let timeoutId: NodeJS.Timeout | undefined;

    /**
     * 処理名: リソースおよびリスナークリーンアップ
     * 処理概要: タイマーおよびワーカーのイベントリスナーを解除する。
     * 実装理由: リークおよび多重呼び出しを防止するため。
     */
    function cleanup(): void {
      if (timeoutId) clearTimeout(timeoutId);
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
    }

    /**
     * 処理名: ワーカーエラーハンドラ
     * 処理概要: クリーンアップを行い推論エラーでPromiseを却下する。
     * 実装理由: ワーカー起動失敗を検出するため。
     */
    function onError(): void {
      cleanup();
      rejectInit(new VectorError("E_INFERENCE"));
    }

    /**
     * 処理名: ワーカー終了ハンドラ
     * 処理概要: 異常終了時にクリーンアップを行いPromiseを却下する。
     * 実装理由: 異常停止を検出するため。
     * @param code - 終了ステータスコード。
     */
    function onExit(code: number): void {
      cleanup();
      if (code !== 0) rejectInit(new VectorError("E_INFERENCE"));
    }

    /**
     * 処理名: ワーカーメッセージハンドラ
     * 処理概要: ワーカーからのready/failed通知を処理する。
     * 実装理由: 初期化完了を検出するため。
     * @param msg - 受信メッセージ。
     */
    function onMessage(msg: unknown): void {
      const data = msg as { kind?: string; code?: ErrorCode } | null;
      if (data?.kind === "ready") {
        cleanup();
        resolveInit();
      } else if (data?.kind === "failed") {
        cleanup();
        rejectInit(new VectorError(data.code ?? "E_INFERENCE"));
      }
    }

    timeoutId = setTimeout(() => {
      cleanup();
      rejectInit(new VectorError("E_TIMEOUT"));
    }, initTimeoutMs);

    worker.on("message", onMessage);
    worker.once("error", onError);
    worker.once("exit", onExit);
  });
}

/**
 * 処理名: ワーカークローズ待機
 * 処理概要: 推論ワーカーへcloseメッセージを送信し、停止完了またはタイムアウトまで待機する。
 * 実装理由: ワーカープロセスの安全な終了を保証するため。
 * @param worker - 終了させるワーカーインスタンス。
 */
async function stopWorker(worker: Worker): Promise<void> {
  const closedPromise = new Promise<void>((res) => {
    /**
     * 処理名: クローズ完了メッセージハンドラ
     * 処理概要: closed通知を受信してPromiseを解決する。
     * 実装理由: ワーカークローズ完了を待機するため。
     * @param msg - 受信メッセージ。
     */
    function onMsg(msg: unknown): void {
      if ((msg as { kind?: string } | null)?.kind === "closed") {
        worker.off("message", onMsg);
        res();
      }
    }
    worker.on("message", onMsg);
    worker.once("exit", () => res());
  });
  worker.postMessage({ kind: "close" });
  await Promise.race([closedPromise, new Promise((res) => setTimeout(res, 2000))]);
  await worker.terminate();
}

/**
 * 処理名: Node推論セッション生成
 * 処理概要: 推論ワーカーを立ち上げ初期化メッセージを送信して通信チャネルを確立する。
 * 実装理由: Node環境での非同期推論セッションを構築するため。
 * @param options - 準備済み埋め込みオプション。
 * @param packageRoot - パッケージルートディレクトリパス。
 * @returns 構築された公式推論セッション。
 */
export async function createNodeInferenceSession(
  options: ReadyEmbeddingOptions,
  packageRoot: string
): Promise<OfficialInferenceSession> {
  const { manifest, manifestHash } = await loadManifest(packageRoot);

  if (options.backend === "directml") {
    await verifyDirectMlBinding(packageRoot);
  }

  const workerPath = resolve(packageRoot, "dist/workers/inference-node.js");
  const worker = new Worker(workerPath);
  const channel = new MessageChannel();

  let closed = false;

  const initPromise = waitForWorkerReady(worker, options.initTimeoutMs);

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

  /**
   * 処理名: 同期推論実行
   * 処理概要: 共有メモリを介して推論ワーカーへ同期リクエストを発行する。
   * 実装理由: SQLite UDFから同期的に埋め込みベクトルを取得するため。
   * @param call - 埋め込み呼び出し情報。
   * @returns 埋め込みバイナリまたはnull。
   */
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

  /**
   * 処理名: セッション終了処理
   * 処理概要: 通信ポートを閉じ推論ワーカーを停止する。
   * 実装理由: 推論セッションのリソースを確実に解放するため。
   * @returns 完了Promise。
   */
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    channel.port1.close();
    await stopWorker(worker);
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
