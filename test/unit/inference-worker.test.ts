import { createResponseBuffer, readResponse } from "../../src/bridge/protocol";
import { handleInferenceRequest } from "../../src/workers/inference";
import { VectorError } from "../../src/errors";

/**
 * 処理名: Worker成功要求検証
 * 処理概要: 同世代の要求を実行しSABへ結果を公開する。
 * 実装理由: 推論結果をmessageの順番ではなく専用bufferへ対応付けるため。
 * @returns 検証完了。
 */
async function verifyWorkerRequest(): Promise<void> {
  const responseBuffer = createResponseBuffer();
  const engine = { embed: jest.fn().mockResolvedValue(new Uint8Array(3072).fill(5)) };
  const request = { protocolVersion: 1, jobId: "job-1", requestId: 1, generation: 2, operation: "document", input: { text: "body", title: "title" }, responseBuffer };
  expect(await handleInferenceRequest(engine, request, 2)).toBe(false);
  expect(engine.embed).toHaveBeenCalledWith({ operation: "document", body: "body", title: "title" });
  expect(readResponse(responseBuffer).payload[0]).toBe(5);
}

/**
 * 処理名: 世代不一致の拒否
 * 処理概要: 古いgenerationではengineを呼ばず応答も書かない。
 * 実装理由: 再起動前の要求が新しいDBへ混入しないため。
 * @returns 検証完了。
 */
async function verifyStaleGeneration(): Promise<void> {
  const responseBuffer = createResponseBuffer();
  const engine = { embed: jest.fn() };
  expect(await handleInferenceRequest(engine, { generation: 1, responseBuffer }, 2)).toBe(false);
  expect(engine.embed).not.toHaveBeenCalled();
  expect(new Int32Array(responseBuffer)[0]).toBe(0);
}

/**
 * 処理名: 画像要求変換検証
 * 処理概要: ArrayBuffer画像を独立したbyte viewとMIMEでengineへ渡す。
 * 実装理由: 画像operationをtext入力として処理する回帰を防ぐため。
 * @returns 検証完了。
 */
async function verifyImageRequest(): Promise<void> {
  const responseBuffer = createResponseBuffer();
  const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
  const engine = { embed: jest.fn().mockResolvedValue(new Uint8Array(3072)) };
  const request = { protocolVersion: 1, jobId: "image", requestId: 4, generation: 2, operation: "image", input: { bytes: bytes.buffer, mime: "image/png" }, responseBuffer };
  expect(await handleInferenceRequest(engine, request, 2)).toBe(false);
  expect(engine.embed).toHaveBeenCalledWith({ operation: "image", bytes, mime: "image/png" });
  expect(readResponse(responseBuffer).payload).toHaveLength(3072);
}

/**
 * 処理名: 入力エラーの公開
 * 処理概要: 安全な内部IDだけをSABへ書く。
 * 実装理由: 例外本文や入力を共有応答へ出さないため。
 * @returns 検証完了。
 */
async function verifyWorkerFailure(): Promise<void> {
  const responseBuffer = createResponseBuffer();
  const engine = { embed: jest.fn().mockRejectedValue(new VectorError("E_INPUT")) };
  const request = { protocolVersion: 1, jobId: "job-1", requestId: 1, generation: 1, operation: "query", input: { text: "" }, responseBuffer };
  expect(await handleInferenceRequest(engine, request, 1)).toBe(false);
  expect(readResponse(responseBuffer)).toEqual({ payload: new Uint8Array(0), errorId: 1 });
}

/**
 * 処理名: protocol違反の公開
 * 処理概要: 版不一致を致命的なprotocolエラーとして通知する。
 * 実装理由: 不明なmessage形式を推論要求として解釈しないため。
 * @returns 検証完了。
 */
async function verifyWorkerProtocolFailure(): Promise<void> {
  const responseBuffer = createResponseBuffer();
  const engine = { embed: jest.fn() };
  expect(await handleInferenceRequest(engine, { protocolVersion: 2, generation: 1, responseBuffer }, 1)).toBe(true);
  expect(readResponse(responseBuffer).errorId).toBe(10);
  expect(engine.embed).not.toHaveBeenCalled();
}

test("R06: Worker publishes matching request", verifyWorkerRequest);
test("G04: Worker maps image operation", verifyImageRequest);
test("R10: stale generation is ignored", verifyStaleGeneration);
test("R10: Worker errors expose only numeric ID", verifyWorkerFailure);
test("R10: protocol failure is fatal", verifyWorkerProtocolFailure);

test("v0.0.3: runtime inference failure is fatal and exposes only its fixed ID", async () => {
  const responseBuffer = createResponseBuffer();
  const engine = { embed: jest.fn().mockRejectedValue(new VectorError("E_INFERENCE")) };
  const request = { protocolVersion: 1, jobId: "runtime-failure", requestId: 1, generation: 1, operation: "query", input: { text: "body" }, responseBuffer };
  expect(await handleInferenceRequest(engine, request, 1)).toBe(true);
  expect(readResponse(responseBuffer)).toEqual({ payload: new Uint8Array(0), errorId: 6 });
});