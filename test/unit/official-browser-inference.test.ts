import { createHash } from "node:crypto";
import { MODEL_ASSET_FILES, MODEL_ID, MODEL_REPOSITORY, MODEL_REVISION } from "../../src/runtime-assets/model-contract";
import { validateEmbeddingOptions } from "../../src/official/options";
import * as browserInference from "../../src/official/browser-inference";

const dummyBytes = new Uint8Array([1, 2, 3]);
const dummySha = createHash("sha256").update(dummyBytes).digest("hex");
const validManifest = {
  schemaVersion: 1,
  modelId: MODEL_ID,
  repository: MODEL_REPOSITORY,
  revision: MODEL_REVISION,
  artifactSetHash: "a".repeat(64),
  fingerprint: "b".repeat(64),
  assets: MODEL_ASSET_FILES.map((a) => ({ path: a.path, bytes: dummyBytes.byteLength, sha256: dummySha }))
};

/**
 * 処理名: ブラウザ Worker/MessageChannel モック構築
 * 処理概要: createBrowserInferenceSession の単体テスト用にグローバル Worker と MessageChannel を差し替える。
 * 実装理由: ブラウザ専用 API を Node.js Jest 環境で決定論的に検証するため。
 * @param behavior - Worker 初期化応答の振る舞い。
 * @returns モックインスタンスとリストア関数。
 */
function setupBrowserGlobals(behavior: "ready" | "failed" | "timeout") {
  const origWorker = (globalThis as Record<string, unknown>).Worker;
  const origChannel = (globalThis as Record<string, unknown>).MessageChannel;
  const origFetch = globalThis.fetch;

  const postedToWorker: Array<{ msg: unknown; transfer?: unknown }> = [];
  const terminateMock = jest.fn();
  const port1CloseMock = jest.fn();
  const port1PostMock = jest.fn();
  const listeners = new Map<string, Set<(ev: unknown) => void>>();

  /**
   * 処理名: モック Worker クラス
   * 処理概要: Web Worker のメッセージ送受信と終了を模擬する。
   * 実装理由: Node.js 環境で Worker 起動プロトコルを単体検証するため。
   */
  class FakeWorker {
    public readonly url: string;
    public readonly options: unknown;
    /**
     * 処理名: FakeWorker コンストラクタ
     * 処理概要: URL とオプションを保持する。
     * 実装理由: 起動パラメータの検証のため。
     * @param url - Worker URL。
     * @param options - Worker オプション。
     */
    constructor(url: string, options?: unknown) {
      this.url = url;
      this.options = options;
      lastWorker = this;
    }
    /**
     * 処理名: イベントリスナー登録
     * 処理概要: リスナーを登録する。
     * 実装理由: ready/failed 通知のテスト配送のため。
     * @param type - イベント種別。
     * @param cb - コールバック。
     */
    addEventListener(type: string, cb: (ev: unknown) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(cb);
    }
    /**
     * 処理名: イベントリスナー解除
     * 処理概要: リスナーを解除する。
     * 実装理由: クリーンアップ動作の検証のため。
     * @param type - イベント種別。
     * @param cb - コールバック。
     */
    removeEventListener(type: string, cb: (ev: unknown) => void) {
      listeners.get(type)?.delete(cb);
    }
    /**
     * 処理名: メッセージ送信模擬
     * 処理概要: initialize 受信時に規定の応答をマイクロタスクで返す。
     * 実装理由: 非同期初期化シーケンスを再現するため。
     * @param msg - 送信メッセージ。
     * @param transfer - 転送オブジェクト。
     */
    postMessage(msg: unknown, transfer?: unknown) {
      postedToWorker.push({ msg, transfer });
      const data = msg as { kind?: string };
      if (data?.kind === "initialize" && behavior !== "timeout") {
        queueMicrotask(() => {
          const payload = behavior === "ready" ? { kind: "ready", backend: "wasm", numThreads: 1 } : { kind: "failed", code: "E_INFERENCE" };
          for (const cb of listeners.get("message") ?? []) {
            cb({ data: payload });
          }
        });
      }
    }
    /**
     * 処理名: Worker 終了模擬
     * 処理概要: terminate 呼び出しを記録する。
     * 実装理由: 解放処理の検証のため。
     */
    terminate() {
      terminateMock();
    }
  }

  let lastWorker: FakeWorker | null = null;
  /**
   * 処理名: モック MessageChannel クラス
   * 処理概要: port1 と port2 を提供する。
   * 実装理由: MessageChannel 転送を単体テストで再現するため。
   */
  class FakeMessageChannel {
    port1 = { postMessage: port1PostMock, close: port1CloseMock, start: jest.fn(), onmessage: null };
    port2 = { start: jest.fn(), close: jest.fn(), onmessage: null };
  }

  (globalThis as Record<string, unknown>).Worker = FakeWorker;
  (globalThis as Record<string, unknown>).MessageChannel = FakeMessageChannel;
  globalThis.fetch = jest.fn(async () => new Response(JSON.stringify(validManifest), { status: 200 })) as unknown as typeof fetch;

  return {
    /**
     * 処理名: 最終起動 Worker 取得
     * 処理概要: 生成された FakeWorker を返す。
     * 実装理由: 起動 URL 検証のため。
     * @returns FakeWorker インスタンス。
     */
    getWorker: () => lastWorker,
    postedToWorker,
    terminateMock,
    port1CloseMock,
    /**
     * 処理名: グローバルモック復元
     * 処理概要: 差し替えたグローバルオブジェクトを元に戻す。
     * 実装理由: 他テストへの副作用を防ぐため。
     */
    restore() {
      (globalThis as Record<string, unknown>).Worker = origWorker;
      (globalThis as Record<string, unknown>).MessageChannel = origChannel;
      globalThis.fetch = origFetch;
    }
  };
}

test("official browser entry: passes prepareInference to initializeOfficialRuntime when embedding is enabled", async () => {
  jest.resetModules();
  const mockSession = {
    infer: jest.fn(),
    close: jest.fn(async () => {}),
    identity: { modelId: "embeddinggemma-2", revision: MODEL_REVISION, fingerprint: "b".repeat(64), profile: "embeddinggemma-2/q4/768", backend: "wasm", runtimeGeneration: 1 },
    information: { ready: true }
  };

  jest.doMock("../../src/official/initialize", () => ({
    initializeOfficialRuntime: jest.fn(async (_factory, _opts, _env, prepareInference) => {
      if (prepareInference) {
        await prepareInference({
          model: { network: "allow", baseUrl: "https://huggingface.co/onnx-community/embeddinggemma-2-ONNX/resolve/main/" },
          backend: "wasm",
          initTimeoutMs: 1000,
          sqlTimeoutMs: 1000
        });
      }
      return { embedding: { close: jest.fn(async () => {}) } };
    })
  }));
  jest.doMock("../../src/official/browser-inference", () => ({
    resolveOfficialBrowserAssets: jest.fn(),
    createBrowserInferenceSession: jest.fn(async () => mockSession)
  }));
  jest.doMock("../../downloads/sqlite-official/sqlite3-bundler-friendly.mjs", () => ({
    default: jest.fn(async () => ({}))
  }), { virtual: true });

  const browserEntry = require("../../src/official/browser") as typeof import("../../src/official/browser");
  const initMod = require("../../src/official/initialize") as typeof import("../../src/official/initialize");
  const infMod = require("../../src/official/browser-inference") as Record<string, unknown>;

  await browserEntry.default({
    embedding: {
      model: { network: "allow", baseUrl: "https://huggingface.co/onnx-community/embeddinggemma-2-ONNX/resolve/main/" }
    }
  });

  expect(initMod.initializeOfficialRuntime).toHaveBeenCalledWith(
    expect.any(Function),
    expect.objectContaining({ embedding: expect.any(Object) }),
    expect.objectContaining({ runtime: "browser" }),
    expect.any(Function)
  );
  expect(infMod.createBrowserInferenceSession).toHaveBeenCalledTimes(1);
});

test("createBrowserInferenceSession: initializes worker, awaits ready, and cleans up on close", async () => {
  const createSession = (browserInference as Record<string, unknown>).createBrowserInferenceSession as
    | ((opts: ReturnType<typeof validateEmbeddingOptions>, entryUrl: string) => Promise<{
        infer: (req: unknown) => unknown;
        close: () => Promise<void>;
        identity: Record<string, unknown>;
        information: Record<string, unknown>;
      }>)
    | undefined;

  expect(typeof createSession).toBe("function");

  const globals = setupBrowserGlobals("ready");
  try {
    const validated = validateEmbeddingOptions(
      {
        model: { network: "allow", baseUrl: "https://huggingface.co/onnx-community/embeddinggemma-2-ONNX/resolve/main/" },
        workerUrl: "https://example.test/assets/inference-browser.mjs"
      } as never,
      { worker: false, runtime: "browser", platform: "browser", architecture: "browser" }
    )!;

    const session = await createSession!(validated, "https://example.test/package/dist/index-browser.mjs");
    expect(globals.getWorker()?.url).toBe("https://example.test/assets/inference-browser.mjs");
    expect(globals.postedToWorker[0]?.msg).toMatchObject({
      kind: "initialize",
      backend: "wasm",
      network: "allow",
      modelBaseUrl: "https://huggingface.co/onnx-community/embeddinggemma-2-ONNX/resolve/main/"
    });
    expect(session.information).toMatchObject({
      ready: true,
      modelId: MODEL_ID,
      dtype: "q4",
      dimension: 768,
      backend: "wasm",
      fingerprint: validManifest.fingerprint
    });

    await session.close();
    expect(globals.postedToWorker.some((p) => (p.msg as { kind?: string }).kind === "close")).toBe(true);
    expect(globals.port1CloseMock).toHaveBeenCalledTimes(1);
    expect(globals.terminateMock).toHaveBeenCalledTimes(1);
  } finally {
    globals.restore();
  }
});

test("createBrowserInferenceSession: rejects with E_INFERENCE on worker failure and E_TIMEOUT on timeout", async () => {
  const createSession = (browserInference as Record<string, unknown>).createBrowserInferenceSession as
    | ((opts: ReturnType<typeof validateEmbeddingOptions>, entryUrl: string) => Promise<unknown>)
    | undefined;
  expect(typeof createSession).toBe("function");

  const validated = validateEmbeddingOptions(
    { model: { network: "offline" }, initTimeoutMs: 20 },
    { worker: false, runtime: "browser", platform: "browser", architecture: "browser" }
  )!;

  const failedGlobals = setupBrowserGlobals("failed");
  try {
    await expect(createSession!(validated, "https://example.test/package/dist/index-browser.mjs")).rejects.toThrow("E_INFERENCE");
    expect(failedGlobals.terminateMock).toHaveBeenCalled();
  } finally {
    failedGlobals.restore();
  }

  const timeoutGlobals = setupBrowserGlobals("timeout");
  try {
    await expect(createSession!(validated, "https://example.test/package/dist/index-browser.mjs")).rejects.toThrow("E_TIMEOUT");
    expect(timeoutGlobals.terminateMock).toHaveBeenCalled();
  } finally {
    timeoutGlobals.restore();
  }
});

test("validateEmbeddingOptions: rejects non-string workerUrl and manifestUrl with E_INPUT", () => {
  const env = { worker: false, runtime: "browser" as const, platform: "browser", architecture: "browser" };
  expect(() =>
    validateEmbeddingOptions({ model: { network: "offline" }, workerUrl: 123 } as never, env)
  ).toThrow("E_INPUT");
  expect(() =>
    validateEmbeddingOptions({ model: { network: "offline" }, manifestUrl: 123 } as never, env)
  ).toThrow("E_INPUT");
});
