import { VectorError } from "../errors";

/**
 * 処理名: health buffer検証
 * 処理概要: undefinedまたは4 byteのSharedArrayBufferだけを受理する。
 * 実装理由: 任意objectをhealth共有領域として扱わないため。
 * @param value - 検証対象。
 * @returns 検証済みbufferまたはundefined。
 */
export function validateInferenceHealth(value: unknown): SharedArrayBuffer | undefined {
  if (value === undefined) return undefined;
  if (!(value instanceof SharedArrayBuffer) || value.byteLength !== 4) throw new VectorError("E_PROTOCOL");
  return value;
}

/**
 * 処理名: health公開
 * 処理概要: READY=1/FAILED=2/CLOSED=3をatomicに保存しnotifyする。
 * 実装理由: messageが止まっていても故障を同期的に検出するため。
 * @param buffer - health buffer。
 * @param state - 公開状態。
 */
export function publishInferenceHealth(buffer: SharedArrayBuffer | undefined, state: 1 | 2 | 3): void {
  if (buffer === undefined) return;
  const view = new Int32Array(buffer);
  Atomics.store(view, 0, state);
  Atomics.notify(view, 0);
}

/**
 * 処理名: READY確認
 * 処理概要: 状態がREADY以外ならE_INFERENCEにする。
 * 実装理由: cache hit前にも推論sessionの故障を検出するため。
 * @param buffer - health buffer。
 */
export function assertInferenceReady(buffer: SharedArrayBuffer): void {
  if (Atomics.load(new Int32Array(buffer), 0) !== 1) throw new VectorError("E_INFERENCE");
}
