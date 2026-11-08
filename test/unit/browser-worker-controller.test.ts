import { createResponseBuffer, readResponse } from "../../src/bridge/protocol";
import { BrowserInferenceController, type BrowserControllerHost, type BrowserControllerInitialization } from "../../src/workers/inference-browser-controller";
import type { InferenceEngine } from "../../src/inference/engine";
import { MODEL_ID, MODEL_REPOSITORY, MODEL_REVISION } from "../../src/runtime-assets/model-contract";

/**
 * 処理名: browser controller fixture
 * 処理概要: Host、MessagePort、engine factoryをmock化する。
 * 実装理由: browser globalと実modelなしでlifecycleを検証するため。
 * @returns controllerと観測用mock。
 */
function browserControllerFixture() {
  const messages: unknown[] = [];
  const host: BrowserControllerHost = { postMessage: jest.fn((message: unknown) => { messages.push(message); }), close: jest.fn() };
  const engine = { embed: jest.fn().mockResolvedValue(new Uint8Array(3072).fill(4)), close: jest.fn().mockResolvedValue(undefined) } as unknown as InferenceEngine;
  const createEngine = jest.fn().mockResolvedValue(engine);
  const port = { onmessage: null, start: jest.fn(), close: jest.fn() } as unknown as MessagePort;
  const initialization: BrowserControllerInitialization = {
    kind: "initialize",
    generation: 3,
    backend: "wasm",
    network: "allow",
    modelBaseUrl: "https://example.test/models/fixed/",
    manifest: { modelId: MODEL_ID, repository: MODEL_REPOSITORY, revision: MODEL_REVISION, artifactSetHash: "b".repeat(64), fingerprint: "a".repeat(64), assets: [] },
    inferencePort: port
  };
  return { controller: new BrowserInferenceController(host, createEngine), host, messages, engine, createEngine, port, initialization };
}

/**
 * 処理名: browser controller lifecycle検証
 * 処理概要: READY、SAB応答、closeを一つのqueue順序で確認する。
 * 実装理由: entry配線とmodel lifecycleを分離して回帰検証するため。
 * @returns 検証完了。
 */
async function verifyBrowserControllerLifecycle(): Promise<void> {
  const fixture = browserControllerFixture();
  fixture.controller.receiveControl(fixture.initialization);
  await fixture.controller.whenIdle();
  expect(fixture.messages).toContainEqual(expect.objectContaining({ kind: "ready", backend: "wasm", numThreads: 1 }));
  expect(fixture.port.start).toHaveBeenCalledTimes(1);
  const responseBuffer = createResponseBuffer();
  const callback = fixture.port.onmessage as unknown as (event: MessageEvent<unknown>) => void;
  callback({ data: { protocolVersion: 1, jobId: "browser-unit", requestId: 1, generation: 3, operation: "query", input: { text: "query" }, responseBuffer } } as MessageEvent<unknown>);
  await fixture.controller.whenIdle();
  expect(readResponse(responseBuffer).payload).toHaveLength(3072);
  fixture.controller.receiveControl({ kind: "close" });
  await fixture.controller.whenIdle();
  expect(fixture.engine.close).toHaveBeenCalledTimes(1);
  expect(fixture.port.close).toHaveBeenCalledTimes(1);
  expect(fixture.host.close).toHaveBeenCalledTimes(1);
}

/**
 * 処理名: browser controller不正初期化検証
 * 処理概要: 未知backendをfactory前に拒否して固定故障通知を返す。
 * 実装理由: 自動fallbackや部分初期化を防ぐため。
 * @returns 検証完了。
 */
async function verifyBrowserControllerFailure(): Promise<void> {
  const fixture = browserControllerFixture();
  fixture.controller.receiveControl({ ...fixture.initialization, backend: "auto" as "wasm" });
  await fixture.controller.whenIdle();
  expect(fixture.createEngine).not.toHaveBeenCalled();
  expect(fixture.messages).toContainEqual({ kind: "failed", code: "E_INPUT" });
}

/**
 * 処理名: browser Worker致命障害検証
 * 処理概要: protocol違反を固定故障通知へ変換しengineとportを解放する。
 * 実装理由: Worker障害後に同じsessionで要求を継続しないため。
 * @returns 検証完了。
 */
async function verifyFatalInferenceFailure(): Promise<void> {
  const fixture = browserControllerFixture();
  fixture.controller.receiveControl(fixture.initialization);
  await fixture.controller.whenIdle();
  const responseBuffer = createResponseBuffer();
  const callback = fixture.port.onmessage as unknown as (event: MessageEvent<unknown>) => void;
  callback({ data: { protocolVersion: 2, jobId: "broken", requestId: 1, generation: 3, responseBuffer } } as MessageEvent<unknown>);
  await fixture.controller.whenIdle();
  expect(readResponse(responseBuffer).errorId).toBe(10);
  expect(fixture.messages).toContainEqual({ kind: "failed", code: "E_INFERENCE" });
  expect(fixture.engine.close).toHaveBeenCalledTimes(1);
  expect(fixture.port.close).toHaveBeenCalledTimes(1);
}

test("G02: browser controller serializes initialize, inference and close", verifyBrowserControllerLifecycle);
test("G02: browser controller rejects unknown backend without fallback", verifyBrowserControllerFailure);
test("G04: browser Worker fatal response releases its session", verifyFatalInferenceFailure);

test("official worker: publishes shared READY/FAILED/CLOSED independently of host events", async () => {
  const fixture = browserControllerFixture();
  const healthBuffer = new SharedArrayBuffer(4);
  fixture.controller.receiveControl({ ...fixture.initialization, healthBuffer });
  await fixture.controller.whenIdle();
  expect(Atomics.load(new Int32Array(healthBuffer), 0)).toBe(1);
  const responseBuffer = createResponseBuffer();
  const callback = fixture.port.onmessage as unknown as (event: MessageEvent<unknown>) => void;
  callback({ data: { protocolVersion: 2, jobId: "broken", requestId: 1, generation: 3, responseBuffer } } as MessageEvent<unknown>);
  await fixture.controller.whenIdle();
  expect(Atomics.load(new Int32Array(healthBuffer), 0)).toBe(2);
  fixture.controller.receiveControl({ kind: "close" });
  await fixture.controller.whenIdle();
  expect(Atomics.load(new Int32Array(healthBuffer), 0)).toBe(3);
});