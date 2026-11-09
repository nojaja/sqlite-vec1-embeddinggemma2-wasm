import { BrowserInferenceController } from "./inference-browser-controller";
import { prepareBrowserInference, configureBrowserGpu } from "../inference/browser-initialize";
import { initializeInferenceEngine, warmupImageBytes } from "../inference/initialize";
import type { PortableRuntime } from "../inference/engine";

/**
 * 処理名: ブラウザ推論Workerエントリー (inference-browser)
 * 処理概要: Web Worker上でInferenceControllerをホストし、メッセージ駆動で初期化および推論を実行する。
 * 実装理由: メインスレッドのUIブロッキングを防ぎ、SAB通信を用いて高速に応答を返すため。
 */
export const WORKER_NAME = "inference-browser";

/**
 * 処理名: 親コンテキストメッセージ送信
 * 処理概要: globalThisのpostMessageを呼び出し親コンテキストへメッセージを送信する。
 * 実装理由: Web Worker通信インターフェースを抽象化するため。
 * @param message - 送信するメッセージデータ。
 */
function sendToHost(message: unknown): void {
  globalThis.postMessage(message);
}

/**
 * 処理名: ワーカー終了処理
 * 処理概要: クローズ通知を送信しglobalThisのcloseを呼び出してWorkerを終了する。
 * 実装理由: ワーカーリソースを確実に破棄するため。
 */
function closeWorker(): void {
  globalThis.postMessage({ kind: "closed" });
  if (typeof (globalThis as unknown as { close?: () => void }).close === "function") {
    (globalThis as unknown as { close: () => void }).close();
  }
}

const controller = new BrowserInferenceController(
  {
    postMessage: sendToHost,
    close: closeWorker
  },
  async (init) => {
    const prep = await prepareBrowserInference({
      workerUrl: location.href,
      modelBaseUrl: init.modelBaseUrl,
      backend: init.backend,
      network: init.network,
      artifactSetHash: init.manifest.artifactSetHash,
      manifestHash: init.manifest.fingerprint,
      assets: init.manifest.assets
    });
    // Transformers / ORT runtime
    const runtimeUrl = new URL("../vendor/transformers-portable.mjs", location.href).href;
    const runtime = await import(/* @vite-ignore */ runtimeUrl);
    await configureBrowserGpu(runtime as unknown as PortableRuntime, init.backend);
    return initializeInferenceEngine(runtime as unknown as PortableRuntime, {
      backend: init.backend,
      cache: prep.cache,
      codecs: prep.codecs,
      wasmUrl: prep.wasmUrl,
      factoryUrl: prep.factoryUrl,
      warmupImage: warmupImageBytes()
    });
  }
);

globalThis.addEventListener("message", (event: MessageEvent<unknown>) => {
  controller.receiveControl(event.data);
});
