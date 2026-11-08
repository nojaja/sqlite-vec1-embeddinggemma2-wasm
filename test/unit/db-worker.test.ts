import { publishResponse } from "../../src/bridge/protocol";
import { VectorError } from "../../src/errors";
import { requestEmbedding, type InferenceRequestPort } from "../../src/workers/db";

type BridgeMessage = { protocolVersion: number; jobId: string; requestId: number; generation: number; operation: string; input: Record<string, unknown>; responseBuffer: SharedArrayBuffer };

/**
 * 処理名: message検査省略
 * 処理概要: envelope検査が不要なtestでmessageを受け取る。
 * 実装理由: 既定callbackもJSDoc付き関数として扱うため。
 */
function ignoreBridgeMessage(): void {}

/**
 * 処理名: 成功port生成
 * 処理概要: 送信と同時に指定payloadをSABへ公開するfake portを返す。
 * 実装理由: 実Workerなしで通知先行とenvelopeを決定的に検証するため。
 * @param payload - 公開するembedding BLOB。
 * @param observe - 送信messageの検査処理。
 * @returns 同期fake port。
 */
function successfulPort(payload: Uint8Array, observe: (message: BridgeMessage) => void = ignoreBridgeMessage): InferenceRequestPort {
  return {
    /**
     * 処理名: fake推論送信
     * 処理概要: messageを検査して指定payloadを即時公開する。
     * 実装理由: 通知先行を時間依存なしで再現するため。
     * @param message - DB bridge要求。
     */
    postMessage(message: unknown): void {
      const typed = message as BridgeMessage;
      observe(typed);
      publishResponse(typed.responseBuffer, payload);
    }
  };
}

/**
 * 処理名: text embedding bridge検証
 * 処理概要: envelopeと独立3072-byte BLOBを確認する。
 * 実装理由: 同期UDFがPromiseや共有viewを返さないことを保証するため。
 */
function verifyTextEmbedding(): void {
  const payload = new Uint8Array(3072).fill(19);
  let responseBuffer: SharedArrayBuffer | undefined;
  const result = requestEmbedding(successfulPort(payload, (message) => {
    expect(message).toMatchObject({ protocolVersion: 1, jobId: "job-1", requestId: 2, generation: 3, operation: "document", input: { text: "body", title: "title" } });
    responseBuffer = message.responseBuffer;
  }), { jobId: "job-1", requestId: 2, generation: 3, operation: "document", body: "body", title: "title" }, new SharedArrayBuffer(4), 1000);
  expect(result).toEqual(payload);
  expect(result).not.toBe(payload);
  new Uint8Array(responseBuffer as SharedArrayBuffer, 32, 3072).fill(0);
  expect(result?.[0]).toBe(19);
}

/**
 * 処理名: SQL NULL短絡検証
 * 処理概要: NULL本文では推論Workerを呼ばずnullを返す。
 * 実装理由: NULL伝播を推論protocol errorへ変換しないため。
 */
function verifyNullShortCircuit(): void {
  const port = { postMessage: jest.fn() };
  expect(requestEmbedding(port, { jobId: "job", requestId: 1, generation: 0, operation: "query", body: null }, new SharedArrayBuffer(4), 1000)).toBeNull();
  expect(port.postMessage).not.toHaveBeenCalled();
}

/**
 * 処理名: 画像copy検証
 * 処理概要: SQLite所有bytesとは別のUint8ArrayをWorkerへ送る。
 * 実装理由: statement終了後のBLOB lifetimeに推論処理を依存させないため。
 */
function verifyImageCopy(): void {
  const source = new Uint8Array([1, 2, 3]);
  requestEmbedding(successfulPort(new Uint8Array(3072), (message) => {
    const sent = message.input.bytes as Uint8Array;
    expect(sent).toEqual(source);
    expect(sent).not.toBe(source);
    source.fill(9);
    expect(sent).toEqual(new Uint8Array([1, 2, 3]));
  }), { jobId: "job", requestId: 1, generation: 0, operation: "image", bytes: source, mime: "image/png" }, new SharedArrayBuffer(4), 1000);
}

/**
 * 処理名: bridge error変換検証
 * 処理概要: 固定数値IDを公開VectorError codeへ変換する。
 * 実装理由: protocol内部IDをDB外へ漏らさず単一mapの対応を固定するため。
 * @param errorId - bridge内部error ID。
 * @param code - 期待する公開code。
 */
function verifyBridgeError(errorId: number, code: string): void {
  const port = successfulPort(new Uint8Array(3072));
  /**
   * 処理名: bridge error公開
   * 処理概要: 指定内部IDの空error応答を同期公開する。
   * 実装理由: error IDごとの変換を実Workerなしで検証するため。
   * @param message - DB bridge要求。
   */
  function publishBridgeError(message: unknown): void {
    publishResponse((message as BridgeMessage).responseBuffer, new Uint8Array(0), errorId);
  }
  port.postMessage = publishBridgeError;
  try {
    requestEmbedding(port, { jobId: "job", requestId: 1, generation: 0, operation: "query", body: "text" }, new SharedArrayBuffer(4), 1000);
    throw new Error("EXPECTED_VECTOR_ERROR");
  } catch (failure) {
    expect(failure).toBeInstanceOf(VectorError);
    expect((failure as VectorError).code).toBe(code);
  }
}

/**
 * 処理名: cancel検証
 * 処理概要: 公開されない応答を共有cancel flagで同期終了する。
 * 実装理由: DB Workerのmessage loopにcancel処理を依存させないため。
 */
function verifyCancellation(): void {
  const cancellation = new SharedArrayBuffer(4);
  Atomics.store(new Int32Array(cancellation), 0, 1);
  const port = { postMessage: jest.fn() };
  expect(requestEmbedding.bind(undefined, port, { jobId: "job", requestId: 1, generation: 0, operation: "query", body: "text" }, cancellation, 1000)).toThrow("E_CANCELLED");
}

/**
 * 処理名: 遅延応答分離検証
 * 処理概要: timeout済み要求への遅延公開が次要求の結果へ混入しないことを確認する。
 * 実装理由: requestごとの使い捨てSAB契約をbridge全体で保証するため。
 */
function verifyDelayedResponseIsolation(): void {
  let delayed: SharedArrayBuffer | undefined;
  const firstPort: InferenceRequestPort = {
    /**
     * 処理名: 遅延要求保持
     * 処理概要: 公開せずに最初の応答SABを保持する。
     * 実装理由: timeout後の遅延応答を決定的に再現するため。
     * @param message - 最初のbridge要求。
     */
    postMessage(message: unknown): void { delayed = (message as BridgeMessage).responseBuffer; }
  };
  expect(requestEmbedding.bind(undefined, firstPort, { jobId: "job", requestId: 1, generation: 4, operation: "query", body: "old" }, new SharedArrayBuffer(4), 0)).toThrow("E_TIMEOUT");
  const fresh = new Uint8Array(3072).fill(29);
  const result = requestEmbedding(successfulPort(fresh), { jobId: "job", requestId: 2, generation: 4, operation: "query", body: "new" }, new SharedArrayBuffer(4), 1000);
  expect(publishResponse(delayed as SharedArrayBuffer, new Uint8Array(3072).fill(7))).toBe(false);
  expect(result).toEqual(fresh);
}

/**
 * 処理名: Worker送信失敗検証
 * 処理概要: MessagePortの送信例外を固定推論エラーへ変換する。
 * 実装理由: Worker固有の例外本文をSQL境界へ漏らさないため。
 */
function verifyWorkerSendFailure(): void {
  const port: InferenceRequestPort = {
    /**
     * 処理名: 送信失敗注入
     * 処理概要: Worker固有例外を同期的に送出する。
     * 実装理由: MessagePort故障時のerror変換を検証するため。
     */
    postMessage(): void { throw new Error("private worker failure"); }
  };
  try {
    requestEmbedding(port, { jobId: "job", requestId: 1, generation: 0, operation: "query", body: "text" }, new SharedArrayBuffer(4), 1000);
    throw new Error("EXPECTED_VECTOR_ERROR");
  } catch (failure) {
    expect(failure).toBeInstanceOf(VectorError);
    expect((failure as VectorError).code).toBe("E_INFERENCE");
  }
}

test("R06: DB bridge returns independent embedding synchronously", verifyTextEmbedding);
test("R03: DB bridge short-circuits SQL NULL", verifyNullShortCircuit);
test("R06: DB bridge copies image bytes", verifyImageCopy);
test.each([[1, "E_INPUT"], [2, "E_TOKEN_LIMIT"], [3, "E_IMAGE_FORMAT"], [4, "E_IMAGE_LIMIT"], [5, "E_EMBEDDING_VALUE"], [6, "E_INFERENCE"], [7, "E_TIMEOUT"], [8, "E_CANCELLED"], [9, "E_MEMORY"], [10, "E_PROTOCOL"]])("R10: DB bridge maps error %i to %s", verifyBridgeError);
test("R10: DB bridge observes cancellation", verifyCancellation);
test("G04: delayed response is isolated from the next request", verifyDelayedResponseIsolation);
test("G04: Worker send failure is sanitized", verifyWorkerSendFailure);
test("R10: DB bridge rejects invalid envelope", () => {
  expect(requestEmbedding.bind(undefined, successfulPort(new Uint8Array(3072)), { jobId: "", requestId: 0, generation: -1, operation: "query", body: "text" }, new SharedArrayBuffer(4), 1000)).toThrow("E_PROTOCOL");
});
test("R03: DB bridge rejects non-byte image", () => {
  expect(requestEmbedding.bind(undefined, successfulPort(new Uint8Array(3072)), { jobId: "job", requestId: 1, generation: 0, operation: "image", bytes: "image", mime: "image/png" }, new SharedArrayBuffer(4), 1000)).toThrow("E_INPUT");
});