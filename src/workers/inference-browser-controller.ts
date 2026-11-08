import { publishInferenceHealth, validateInferenceHealth } from "../bridge/inference-health";
import { VectorError } from "../errors";
import type { InferenceEngine } from "../inference/engine";
import { MODEL_ID, MODEL_REPOSITORY, MODEL_REVISION, type ModelAssetDigest } from "../runtime-assets/model-contract";
import { handleInferenceRequest } from "./inference";

/** controllerが必要とするhost境界。 */
export interface BrowserControllerHost { postMessage(message: unknown): void; close(): void }

/** 初期化control message。 */
export interface BrowserControllerInitialization {
  kind: "initialize";
  generation: number;
  backend: "wasm" | "webgpu";
  network: "allow" | "offline";
  modelBaseUrl: string;
  manifest: { modelId: string; repository: string; revision: string; artifactSetHash: string; fingerprint: string; assets: ModelAssetDigest[] };
  inferencePort: MessagePort;
  healthBuffer?: SharedArrayBuffer;
}

type ControlMessage = BrowserControllerInitialization | { kind: "close" };

/**
 * 処理名: browser推論controller
 * 処理概要: initialize/inference/closeをPromise chainで直列化する。
 * 実装理由: lifecycleをWorker entryの配線から分離して検証可能にするため。
 */
export class BrowserInferenceController {
  private chain: Promise<void> = Promise.resolve();
  private engine: InferenceEngine | undefined;
  private port: MessagePort | undefined;
  private health: SharedArrayBuffer | undefined;
  private initialized = false;
  private stopped = false;
  private readonly host: BrowserControllerHost;
  private readonly createEngine: (initialization: BrowserControllerInitialization) => Promise<InferenceEngine>;

  /**
   * 処理名: controller生成
   * 処理概要: hostとengine factoryを保持する。
   * 実装理由: browser globalなしでmock可能にするため。
   * @param host - postMessage/closeを持つhost。
   * @param createEngine - warm-up済みengine factory。
   */
  public constructor(host: BrowserControllerHost, createEngine: (initialization: BrowserControllerInitialization) => Promise<InferenceEngine>) {
    this.host = host;
    this.createEngine = createEngine;
  }

  /**
   * 処理名: control受信
   * 処理概要: control messageを直列chainへ追加する。
   * 実装理由: 初期化と終了の競合を避けるため。
   * @param message - control message。
   */
  public receiveControl(message: unknown): void {
    this.enqueue(async () => {
      const control = message as ControlMessage | null;
      if (control?.kind === "initialize" && !this.initialized) await this.initialize(control);
      else if (control?.kind === "close") await this.close();
      else this.host.postMessage({ kind: "failed", code: "E_PROTOCOL" });
    });
  }

  /**
   * 処理名: 直列実行登録
   * 処理概要: 失敗してもqueueが止まらないようにchainへ追加する。
   * 実装理由: 失敗後の後続処理もcatchで処理するため。
   * @param action - 実行する処理。
   */
  private enqueue(action: () => Promise<void>): void {
    this.chain = this.chain.then(action).catch(() => undefined);
  }

  /**
   * 処理名: idle待機
   * 処理概要: 追加された全処理の完了まで待つ。
   * 実装理由: testとcloseが処理完了を観測するため。
   */
  public async whenIdle(): Promise<void> {
    let current: Promise<void>;
    do {
      current = this.chain;
      await current;
    } while (current !== this.chain);
  }

  /**
   * 処理名: manifest検証
   * 処理概要: 固定model識別子と64桁hashを確認する。
   * 実装理由: 別model/revisionで初期化しないため。
   * @param init - 初期化message。
   */
  private validate(init: BrowserControllerInitialization): void {
    if (init.backend !== "wasm" && init.backend !== "webgpu") throw new VectorError("E_INPUT");
    if (!Number.isSafeInteger(init.generation) || init.generation < 0) throw new VectorError("E_PROTOCOL");
    const manifest = init.manifest;
    const hash = /^[0-9a-f]{64}$/;
    const valid = manifest.modelId === MODEL_ID && manifest.repository === MODEL_REPOSITORY && manifest.revision === MODEL_REVISION
      && hash.test(manifest.artifactSetHash) && hash.test(manifest.fingerprint);
    if (!valid) throw new VectorError("E_ASSET_INTEGRITY");
  }

  /**
   * 処理名: 初期化
   * 処理概要: engineを作成しportを開始してREADYを通知する。
   * 実装理由: warm-up後だけREADYにするため。
   * @param init - 初期化message。
   */
  private async initialize(init: BrowserControllerInitialization): Promise<void> {
    try {
      this.validate(init);
      this.health = validateInferenceHealth(init.healthBuffer);
      this.initialized = true;
      this.engine = await this.createEngine(init);
      this.port = init.inferencePort;
      this.port.onmessage = (event: MessageEvent<unknown>): void => this.enqueue(() => this.infer(event.data, init.generation));
      this.port.start();
      publishInferenceHealth(this.health, 1);
      this.host.postMessage({ kind: "ready", backend: init.backend, numThreads: 1 });
    } catch (error) {
      this.initialized = this.initialized || false;
      await this.fail((error as { code?: string } | null)?.code ?? "E_INFERENCE", init.inferencePort);
    }
  }

  /**
   * 処理名: 推論処理
   * 処理概要: handlerを実行し致命的ならsessionを故障終了する。
   * 実装理由: 故障後に同じsessionで要求を継続しないため。
   * @param data - 受信message。
   * @param generation - 世代。
   */
  private async infer(data: unknown, generation: number): Promise<void> {
    if (this.engine === undefined || this.stopped) return;
    const fatal = await handleInferenceRequest(this.engine, data, generation);
    if (fatal) await this.fail("E_INFERENCE", this.port);
  }

  /**
   * 処理名: 故障終了
   * 処理概要: FAILEDを公開しengineとportを解放して故障を通知する。
   * 実装理由: 固定codeだけをhostへ返すため。
   * @param code - 通知するcode。
   * @param port - 閉じるport。
   */
  private async fail(code: string, port: MessagePort | undefined): Promise<void> {
    this.stopped = true;
    publishInferenceHealth(this.health, 2);
    const engine = this.engine;
    this.engine = undefined;
    await engine?.close().catch(() => undefined);
    port?.close();
    this.port = undefined;
    this.host.postMessage({ kind: "failed", code });
  }

  /**
   * 処理名: 終了
   * 処理概要: engine/portを解放してCLOSEDを公開しhostを閉じる。
   * 実装理由: Worker終了時に全資源を解放するため。
   */
  private async close(): Promise<void> {
    this.stopped = true;
    const engine = this.engine;
    this.engine = undefined;
    await engine?.close().catch(() => undefined);
    this.port?.close();
    this.port = undefined;
    publishInferenceHealth(this.health, 3);
    this.host.close();
  }
}
