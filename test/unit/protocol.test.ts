import { abandonResponse, createResponseBuffer, publishResponse, readResponse, waitResponse } from "../../src/bridge/protocol";

/**
 * 処理名: 通知先行の検証
 * 処理概要: wait開始前に公開済みの結果を待機せず取得する。
 * 実装理由: notifyが先行しても通知を取りこぼさないため。
 */
function verifyNotificationBeforeWait(): void {
  const response = createResponseBuffer();
  expect(response.byteLength).toBe(8192);
  expect(new Int32Array(response, 0, 8)[4]).toBe(1);
  const payload = new Uint8Array(3072).fill(17);
  expect(publishResponse(response, payload)).toBe(true);
  expect(publishResponse(response, new Uint8Array(3072))).toBe(false);
  const wait = jest.spyOn(Atomics, "wait");
  const result = waitResponse(response, new SharedArrayBuffer(4), performance.now() + 1000);
  expect(result.errorId).toBe(0);
  expect(result.payload).toEqual(payload);
  expect(wait).not.toHaveBeenCalled();
  new Uint8Array(response, 32).fill(0);
  expect(result.payload).toEqual(payload);
}

/**
 * 処理名: 待機中公開の検証
 * 処理概要: waitの起床後に状態を再読込みすることを検証する。
 * 実装理由: waitの戻り値だけで成功を推測しないため。
 */
function verifyPublicationDuringWait(): void {
  const response = createResponseBuffer();
  /**
   * 処理名: 決定的な起床
   * 処理概要: wait境界で結果を公開して起床を再現する。
   * 実装理由: 時間依存の不安定なrace testを避けるため。
   * @returns 状態変更による起床。
   */
  function wakeWithResult(): "not-equal" {
    publishResponse(response, new Uint8Array(3072).fill(23));
    return "not-equal";
  }
  const wait = jest.spyOn(Atomics, "wait").mockImplementation(wakeWithResult);
  expect(waitResponse(response, new SharedArrayBuffer(4), performance.now() + 1000).payload[0]).toBe(23);
  expect(wait).toHaveBeenCalledTimes(1);
  expect(wait.mock.calls[0]?.[3]).toBeLessThanOrEqual(50);
}

/**
 * 処理名: 放棄と遅延書込み検証
 * 処理概要: pending/writingから放棄し、遅延応答を拒否する。
 * 実装理由: 古い結果が次のrequestへ混入することを防ぐため。
 * @param state - 放棄直前のstate。
 */
function verifyAbandonment(state: number): void {
  const response = createResponseBuffer();
  Atomics.store(new Int32Array(response), 0, state);
  expect(abandonResponse(response)).toBe(true);
  expect(Atomics.load(new Int32Array(response), 0)).toBe(4);
  expect(publishResponse(response, new Uint8Array(3072))).toBe(false);
  expect(createResponseBuffer()).not.toBe(response);
}

/**
 * 処理名: 確定済み応答の保護
 * 処理概要: 成功またはエラー公開後に状態を放棄で上書きしない。
 * 実装理由: producerとcancelの競合で確定結果を破壊しないため。
 */
function verifyPublishedResponseProtection(): void {
  const response = createResponseBuffer();
  publishResponse(response, new Uint8Array(3072));
  expect(abandonResponse(response)).toBe(false);
  expect(Atomics.load(new Int32Array(response), 0)).toBe(2);
}

/**
 * 処理名: 期限超過の検証
 * 処理概要: 期限切れのpending/writing応答を放棄して終了する。
 * 実装理由: 同期SQL Workerが無期限に待機しないため。
 * @param state - 期限時のstate。
 */
function verifyTimeout(state: number): void {
  const response = createResponseBuffer();
  Atomics.store(new Int32Array(response), 0, state);
  expect(waitResponse.bind(undefined, response, new SharedArrayBuffer(4), performance.now() - 1)).toThrow("E_TIMEOUT");
  expect(Atomics.load(new Int32Array(response), 0)).toBe(4);
}

/**
 * 処理名: cancel検証
 * 処理概要: job用SABのflagを同期ループから観測する。
 * 実装理由: 待機中Workerのonmessageへcancelを依存させないため。
 */
function verifyCancellation(): void {
  const response = createResponseBuffer();
  const cancellation = new SharedArrayBuffer(4);
  Atomics.store(new Int32Array(cancellation), 0, 1);
  expect(waitResponse.bind(undefined, response, cancellation, performance.now() + 1000)).toThrow("E_CANCELLED");
  expect(waitResponse.bind(undefined, response, cancellation, performance.now() + 1000)).toThrow("E_CANCELLED");
}

/**
 * 処理名: 破損header検証
 * 処理概要: 公開後の長さ、次元、版、予約領域を拒否する。
 * 実装理由: 不正なWorker応答を成功BLOBとしてSQLiteへ渡さないため。
 * @param index - header index。
 * @param value - 不正値。
 */
function verifyCorruptHeader(index: number, value: number): void {
  const response = createResponseBuffer();
  publishResponse(response, new Uint8Array(3072));
  Atomics.store(new Int32Array(response), index, value);
  expect(readResponse.bind(undefined, response)).toThrow("E_PROTOCOL");
}

/**
 * 処理名: error payload境界検証
 * 処理概要: 固定error IDと4096-byte以下のpayloadを検証する。
 * 実装理由: error時も容量超過や未知codeを受け付けないため。
 */
function verifyErrorPayload(): void {
  const response = createResponseBuffer();
  expect(publishResponse(response, new Uint8Array(4096), 6)).toBe(true);
  expect(readResponse(response).errorId).toBe(6);
  expect(readResponse(response).payload.byteLength).toBe(4096);
  expect(publishResponse.bind(undefined, createResponseBuffer(), new Uint8Array(4097), 6)).toThrow("E_PROTOCOL");
  expect(publishResponse.bind(undefined, createResponseBuffer(), new Uint8Array(0), 11)).toThrow("E_PROTOCOL");
  expect(publishResponse.bind(undefined, createResponseBuffer(), new Uint8Array(0), 0)).toThrow("E_PROTOCOL");
}

/**
 * 処理名: 不正buffer検証
 * 処理概要: SABサイズと内部期限の不正を拒否する。
 * 実装理由: RangeErrorや無期限waitへ契約違反を漏らさないため。
 */
function verifyInvalidBuffers(): void {
  expect(readResponse.bind(undefined, new SharedArrayBuffer(16))).toThrow("E_PROTOCOL");
  expect(readResponse.bind(undefined, createResponseBuffer())).toThrow("E_PROTOCOL");
  expect(waitResponse.bind(undefined, createResponseBuffer(), new SharedArrayBuffer(0), 1)).toThrow("E_PROTOCOL");
  expect(waitResponse.bind(undefined, createResponseBuffer(), new ArrayBuffer(4) as unknown as SharedArrayBuffer, 1)).toThrow("E_PROTOCOL");
  expect(waitResponse.bind(undefined, createResponseBuffer(), new SharedArrayBuffer(4), Number.NaN)).toThrow("E_PROTOCOL");
}

/**
 * 処理名: 書込み途中の放棄検証
 * 処理概要: payload書込み直後にcancelが勝つ競合を再現する。
 * 実装理由: writerの最終CASが放棄済み状態を成功へ戻さないため。
 */
function verifyAbandonmentDuringWrite(): void {
  const response = createResponseBuffer();
  const originalSet = Uint8Array.prototype.set;
  /**
   * 処理名: 書込み後の放棄注入
   * 処理概要: 実payloadを書いた後にreaderの放棄を再現する。
   * 実装理由: 決定的にwriter公開前の競合区間を検証するため。
   * @param values - 書き込むpayload。
   * @param offset - 書込み開始位置。
   */
  function abandonAfterWrite(values: ArrayLike<number>, offset?: number): void {
    originalSet.call(new Uint8Array(response, 32), values, offset);
    abandonResponse(response);
  }
  jest.spyOn(Uint8Array.prototype, "set").mockImplementation(abandonAfterWrite);
  expect(publishResponse(response, new Uint8Array(3072))).toBe(false);
  expect(Atomics.load(new Int32Array(response), 0)).toBe(4);
  expect(readResponse.bind(undefined, response)).toThrow("E_PROTOCOL");
}

test("R06: notification before wait and independent payload", verifyNotificationBeforeWait);
test("R06: load state again after wait", verifyPublicationDuringWait);
test.each([0, 1, 4])("R10: abandon state %i and reject stale writes", verifyAbandonment);
test("R10: never overwrite published response", verifyPublishedResponseProtection);
test.each([0, 1])("R10: deadline abandons state %i", verifyTimeout);
test("R10: cancellation through shared flag", verifyCancellation);
test.each([[0, 99], [1, 3071], [1, -1], [2, 6], [3, 767], [4, 2], [5, 1], [6, 1], [7, 1]])("R10: reject corrupt header %i=%i", verifyCorruptHeader);
test("R10: bounded error payload", verifyErrorPayload);
test("R10: invalid buffers and deadlines", verifyInvalidBuffers);
test("R10: abandonment wins while writer owns payload", verifyAbandonmentDuringWrite);