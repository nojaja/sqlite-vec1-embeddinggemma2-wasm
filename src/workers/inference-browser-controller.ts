import { VectorError } from "../errors";
import { publishInferenceHealth, HEALTH_READY, HEALTH_FAILED, HEALTH_CLOSED } from "../bridge/inference-health";
import { handleInferenceRequest } from "./inference";
import type { InferenceEngine } from "../inference/engine";
import { publishResponse } from "../bridge/protocol";

/**
 * 処理名: ブラウザワーカーホスト境界インターフェース
 * 処理概要: Web Worker の self (DedicatedWorkerGlobalScope) 相当のメッセージ送信および終了機能を提供する。
 * 実装理由: グローバル環境に直接依存せずコントローラーの単体テストを可能にするため。
 */
export interface BrowserControllerHost {
  postMessage(message: unknown): void;
  close(): void;
}

/**
 * 処理名: ブラウザモデルエントリ初期化型
 * 処理概要: マルチモデル構成における個別モデルの URL・ネットワーク・事前ロード設定を保持する。
 * 実装理由: ブラウザ Worker 内で複数モデルのオンデマンドロードを制御するため。
 */
export interface BrowserModelEntryInit {
  modelBaseUrl?: string;
  network?: "allow" | "offline";
  preload?: boolean;
  manifest: BrowserControllerInitialization["manifest"];
}

/**
 * 処理名: ブラウザ推論初期化メッセージ
 * 処理概要: バックエンド、通信モード、モデル配置先、マニフェスト、MessagePort 等を含む初期化ペイロード。
 */
export interface BrowserControllerInitialization {
  kind: "initialize";
  generation: number;
  backend: "wasm" | "webgpu";
  network: "allow" | "offline";
  modelBaseUrl: string;
  manifest: {
    schemaVersion?: number;
    modelId: string;
    repository: string;
    revision: string;
    artifactSetHash: string;
    fingerprint: string;
    profile?: Record<string, unknown>;
    assets: unknown[];
  };
  models?: Record<string, BrowserModelEntryInit>;
  defaultModel?: string;
  inferencePort: MessagePort;
  healthBuffer?: SharedArrayBuffer;
}

/**
 * 処理名: ブラウザ制御メッセージ共用体
 * 処理概要: 初期化要求またはクローズ要求を表す。
 */
export type BrowserControlMessage = BrowserControllerInitialization | { kind: "close" };

/**
 * 処理名: ブラウザ推論ワーカーコントローラークラス
 * 処理概要: ブラウザ Web Worker 内でのモデル初期化、推論プロトコル処理、ヘルス状態公開、終了ライフサイクルを一元管理する。
 * 実装理由: UIスレッドやDBワーカーからの非同期要求をシリアライズし、障害時の安全な解放を保証するため。
 */
export class BrowserInferenceController {
  private readonly host: BrowserControllerHost;
  private readonly createEngine: (init: BrowserControllerInitialization) => Promise<InferenceEngine>;
  private queue: Promise<void> = Promise.resolve();
  private readonly engines = new Map<string, InferenceEngine>();
  private readonly modelConfigs = new Map<string, BrowserControllerInitialization>();
  private defaultModelName = "";
  private port: MessagePort | null = null;
  private healthBuffer?: SharedArrayBuffer;
  private generation = 0;
  private closed = false;

  /**
   * 処理名: BrowserInferenceController コンストラクタ
   * 処理概要: ホスト境界およびエンジン生成ファクトリを注入する。
   * @param host - ワーカーホスト境界。
   * @param createEngine - エンジン生成ファクトリ。
   */
  constructor(
    host: BrowserControllerHost,
    createEngine: (init: BrowserControllerInitialization) => Promise<InferenceEngine>
  ) {
    this.host = host;
    this.createEngine = createEngine;
  }

  /**
   * 処理名: 制御メッセージ受信
   * 処理概要: 初期化またはクローズメッセージをキューに直列投入して実行する。
   * 実装理由: 非同期タスクの実行順序を保証し、競合状態を排除するため。
   * @param message - 制御メッセージ。
   */
  public receiveControl(message: BrowserControlMessage): void {
    this.queue = this.queue.then(async () => {
      if (message.kind === "initialize") {
        if (this.closed) return;
        await this.handleInitialize(message);
      } else if (message.kind === "close") {
        await this.handleClose();
      }
    });
  }

  /**
   * 処理名: アイドル待機
   * 処理概要: 現在キューに入っているすべての非同期タスクの完了を待機する。
   * 実装理由: テストおよび終了処理で非同期完了を決定論的に同期するため。
   * @returns 完了 Promise。
   */
  public async whenIdle(): Promise<void> {
    await this.queue;
  }

  /**
   * 処理名: 初期化処理
   * 処理概要: バックエンド検証、初期モデルエンジン生成、MessagePort 接続、READY 公開を行う。
   * @param init - 初期化パラメーター。
   */
  private async handleInitialize(init: BrowserControllerInitialization): Promise<void> {
    this.healthBuffer = init.healthBuffer;
    this.generation = init.generation;
    if (init.backend !== "wasm" && init.backend !== "webgpu") {
      this.host.postMessage({ kind: "failed", code: "E_INPUT" });
      return;
    }

    try {
      this.registerModelConfigs(init);
      await this.preloadInitialModels();
      this.port = init.inferencePort;

      this.port.onmessage = (event: MessageEvent<unknown>) => {
        this.queue = this.queue.then(async () => {
          if (this.closed || this.engines.size === 0) return;
          await this.handlePortMessage(event.data);
        });
      };

      if (typeof this.port.start === "function") {
        this.port.start();
      }

      publishInferenceHealth(this.healthBuffer, HEALTH_READY);
      this.host.postMessage({
        kind: "ready",
        backend: init.backend,
        numThreads: 1
      });
    } catch (err: unknown) {
      console.error("Browser handleInitialize error:", err);
      this.host.postMessage({
        kind: "progress",
        stage: "init-error",
        errorName: (err as Error)?.stack ?? String(err)
      });
      publishInferenceHealth(this.healthBuffer, HEALTH_FAILED);
      this.host.postMessage({ kind: "failed", code: "E_INFERENCE" });
      await this.cleanup();
    }
  }

  /**
   * 処理名: モデル設定マップ登録
   * 処理概要: 初期化ペイロードの models または単一 manifest を内部モデルレジストリへ登録する。
   * 実装理由: 起動時ロード対象とオンデマンドロード対象を一元管理するため。
   * @param init - 初期化ペイロード。
   */
  private registerModelConfigs(init: BrowserControllerInitialization): void {
    this.modelConfigs.clear();
    if (init.models && Object.keys(init.models).length > 0) {
      const keys = Object.keys(init.models);
      this.defaultModelName = init.defaultModel ?? keys[0]!;
      for (const name of keys) {
        const entry = init.models[name]!;
        this.modelConfigs.set(name, {
          ...init,
          network: entry.network ?? init.network,
          modelBaseUrl: entry.modelBaseUrl ?? init.modelBaseUrl,
          manifest: entry.manifest,
          defaultModel: name
        });
      }
      return;
    }
    this.defaultModelName = init.defaultModel ?? init.manifest.modelId;
    this.modelConfigs.set(this.defaultModelName, init);
  }

  /**
   * 処理名: 初期モデル事前ロード
   * 処理概要: defaultModel および preload 指定モデルを起動時にロードする。
   * 実装理由: 不要なモデルの一括ロードを避けつつ既定モデルを即座に利用可能にするため。
   */
  private async preloadInitialModels(): Promise<void> {
    for (const [name, cfg] of this.modelConfigs.entries()) {
      const entry = cfg.models?.[name];
      const shouldPreload = name === this.defaultModelName || entry?.preload === true;
      if (shouldPreload) {
        const engine = await this.createEngine(cfg);
        this.engines.set(name, engine);
      }
    }
  }

  /**
   * 処理名: 推論エンジン動的解決・ロード
   * 処理概要: ロード済みエンジンを返却し、未ロードの登録モデルであればオンデマンドで生成・キャッシュする。
   * 実装理由: embedding(text, model) 呼び出し時に他モデルを動的に切り替えて推論するため。
   * @param modelName - 要求モデル名。
   * @returns 推論エンジン、または未登録モデルの場合 undefined。
   */
  private async resolveOrLoadEngine(modelName?: string): Promise<InferenceEngine | undefined> {
    const target = modelName ?? this.defaultModelName;
    const existing = this.engines.get(target);
    if (existing) {
      return existing;
    }
    const cfg = this.modelConfigs.get(target);
    if (!cfg) {
      return undefined;
    }
    const engine = await this.createEngine(cfg);
    this.engines.set(target, engine);
    return engine;
  }

  /**
   * 処理名: ポートメッセージ処理
   * 処理概要: 推論要求を処理し、致命的エラー発生時にはセッションを破棄して FAILED を通知する。
   * @param data - メッセージデータ。
   */
  private async handlePortMessage(data: unknown): Promise<void> {
    if (this.engines.size === 0) return;

    let isFatal = false;
    try {
      isFatal = await handleInferenceRequest(
        (modelName) => this.resolveOrLoadEngine(modelName),
        data,
        this.generation
      );
    } catch {
      isFatal = true;
    }

    if (isFatal) {
      publishInferenceHealth(this.healthBuffer, HEALTH_FAILED);
      this.host.postMessage({ kind: "failed", code: "E_INFERENCE" });
      await this.cleanup();
    }
  }

  /**
   * 処理名: クローズ処理
   * 処理概要: CLOSED ヘルス公開、リソース解放、ホスト終了を実行する。
   */
  private async handleClose(): Promise<void> {
    publishInferenceHealth(this.healthBuffer, HEALTH_CLOSED);
    await this.cleanup();
    this.host.postMessage({ kind: "closed" });
    this.host.close();
  }

  /**
   * 処理名: 内部リソース解放
   * 処理概要: 保持しているすべての推論エンジンおよび MessagePort を安全にクローズする。
   */
  private async cleanup(): Promise<void> {
    this.closed = true;
    for (const engine of this.engines.values()) {
      try {
        await engine.close();
      } catch {
        // 解放エラーは無視
      }
    }
    this.engines.clear();
    if (this.port) {
      try {
        this.port.close();
      } catch {
        // 解放エラーは無視
      }
      this.port = null;
    }
  }
}
