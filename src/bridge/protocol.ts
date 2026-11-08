import { VectorError } from "../errors";

/** 応答の読出し結果。 */
export interface BridgeResponse { payload: Uint8Array; errorId: number }

const HEADER_BYTES = 32;
const BUFFER_BYTES = 8192;
const MAX_PAYLOAD = BUFFER_BYTES - HEADER_BYTES;
const PENDING = 0;
const WRITING = 1;
const OK = 2;
const ERROR = 3;
const ABANDONED = 4;
const SUCCESS_BYTES = 3072;

/**
 * 処理名: 応答buffer検証
 * 処理概要: 8192 byteのSharedArrayBufferかを確認しheaderを返す。
 * 実装理由: 不正bufferでRangeErrorを漏らさないため。
 * @param buffer - 応答buffer。
 * @returns header用Int32Array。
 */
function header(buffer: SharedArrayBuffer): Int32Array {
  if (!(buffer instanceof SharedArrayBuffer) || buffer.byteLength !== BUFFER_BYTES) throw new VectorError("E_PROTOCOL");
  return new Int32Array(buffer, 0, 8);
}

/**
 * 処理名: cancel flag検証
 * 処理概要: 4 byteのSharedArrayBufferからInt32Arrayを作る。
 * 実装理由: 異容量や通常ArrayBufferを拒否するため。
 * @param buffer - cancel buffer。
 * @returns flag view。
 */
function cancelFlag(buffer: SharedArrayBuffer): Int32Array {
  if (!(buffer instanceof SharedArrayBuffer) || buffer.byteLength !== 4) throw new VectorError("E_PROTOCOL");
  return new Int32Array(buffer);
}

/**
 * 処理名: 応答buffer生成
 * 処理概要: version=1の新品buffer(8192B)を作る。
 * 実装理由: 要求ごとに使い捨てて遅延書込みの混入を防ぐため。
 * @returns 新しいSharedArrayBuffer。
 */
export function createResponseBuffer(): SharedArrayBuffer {
  const buffer = new SharedArrayBuffer(BUFFER_BYTES);
  Atomics.store(new Int32Array(buffer, 0, 8), 4, 1);
  return buffer;
}

/**
 * 処理名: 応答公開
 * 処理概要: CASで占有しpayloadとheaderを書いて最後にOK/ERRORへ公開する。
 * 実装理由: 放棄済み・二重応答を成功へ戻さないため。
 * @param buffer - 応答buffer。
 * @param payload - 応答payload。
 * @param errorId - 0は成功、1..10はerror ID。
 * @returns 公開に成功したか。
 */
export function publishResponse(buffer: SharedArrayBuffer, payload: Uint8Array, errorId = 0): boolean {
  const state = header(buffer);
  if (!Number.isInteger(errorId) || errorId < 0 || errorId > 10) throw new VectorError("E_PROTOCOL");
  if (errorId === 0 ? payload.byteLength !== SUCCESS_BYTES : payload.byteLength > 4096) throw new VectorError("E_PROTOCOL");
  if (Atomics.compareExchange(state, 0, PENDING, WRITING) !== PENDING) return false;
  new Uint8Array(buffer, HEADER_BYTES, MAX_PAYLOAD).set(payload, 0);
  Atomics.store(state, 1, payload.byteLength);
  Atomics.store(state, 2, errorId);
  Atomics.store(state, 3, errorId === 0 ? 768 : 0);
  Atomics.store(state, 4, 1);
  for (let index = 5; index < 8; index += 1) Atomics.store(state, index, 0);
  if (Atomics.compareExchange(state, 0, WRITING, errorId === 0 ? OK : ERROR) !== WRITING) return false;
  Atomics.notify(state, 0);
  return true;
}

/**
 * 処理名: 応答読取り
 * 処理概要: terminal state後にheaderを検証しpayloadをcopyする。
 * 実装理由: 破損応答を成功BLOBとして扱わないため。
 * @param buffer - 応答buffer。
 * @returns payloadとerrorId。
 */
export function readResponse(buffer: SharedArrayBuffer): BridgeResponse {
  const state = header(buffer);
  const terminal = Atomics.load(state, 0);
  if (terminal !== OK && terminal !== ERROR) throw new VectorError("E_PROTOCOL");
  const length = Atomics.load(state, 1);
  const errorId = Atomics.load(state, 2);
  const dimension = Atomics.load(state, 3);
  const valid = Atomics.load(state, 4) === 1
    && [5, 6, 7].every((index) => Atomics.load(state, index) === 0)
    && length >= 0
    && (terminal === OK ? length === SUCCESS_BYTES && errorId === 0 && dimension === 768 : length <= 4096 && errorId >= 1 && errorId <= 10 && dimension === 0);
  if (!valid) throw new VectorError("E_PROTOCOL");
  return { payload: new Uint8Array(buffer, HEADER_BYTES, length).slice(), errorId };
}

/**
 * 処理名: 応答放棄
 * 処理概要: PENDING/WRITINGをABANDONEDへ遷移する。
 * 実装理由: cancel/deadline後の遅延書込みを拒否するため。
 * @param buffer - 応答buffer。
 * @returns 放棄が成立したか。
 */
export function abandonResponse(buffer: SharedArrayBuffer): boolean {
  const state = header(buffer);
  const current = Atomics.load(state, 0);
  if (current === OK || current === ERROR) return false;
  if (current === ABANDONED) return true;
  if (current !== PENDING && current !== WRITING) throw new VectorError("E_PROTOCOL");
  const previous = Atomics.compareExchange(state, 0, current, ABANDONED);
  if (previous === current) return true;
  return previous === ABANDONED ? true : false;
}

/**
 * 処理名: 応答待機
 * 処理概要: terminal観測、cancel、deadlineを最大50ms間隔で確認して待つ。
 * 実装理由: 通知先行を取りこぼさず無期限waitを避けるため。
 * @param buffer - 応答buffer。
 * @param cancel - cancel flag buffer。
 * @param deadline - performance.now基準の期限。
 * @returns 読取り結果。
 */
export function waitResponse(buffer: SharedArrayBuffer, cancel: SharedArrayBuffer, deadline: number): BridgeResponse {
  const state = header(buffer);
  const flag = cancelFlag(cancel);
  if (!Number.isFinite(deadline)) throw new VectorError("E_PROTOCOL");
  for (;;) {
    const current = Atomics.load(state, 0);
    if (current === OK || current === ERROR) return readResponse(buffer);
    if (current === ABANDONED) throw new VectorError("E_CANCELLED");
    if (Atomics.load(flag, 0) !== 0) {
      if (abandonResponse(buffer)) throw new VectorError("E_CANCELLED");
      continue;
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      if (abandonResponse(buffer)) throw new VectorError("E_TIMEOUT");
      continue;
    }
    Atomics.wait(state, 0, current, Math.min(50, remaining));
  }
}
