import { VectorError } from "../errors";

/**
 * 処理名: ヘルス状態定数定義
 * 処理概要: 推論セッションのヘルス状態（READY=1, FAILED=2, CLOSED=3）を定義する。
 * 実装理由: セッション健全性をプロセス/ワーカー間で共有するため。
 */
export const HEALTH_READY = 1;
export const HEALTH_FAILED = 2;
export const HEALTH_CLOSED = 3;

/**
 * 処理名: ヘルスバッファ検証
 * 処理概要: 引数が undefined または 4 バイトの SharedArrayBuffer であることを検証する。
 * 実装理由: 不正な型や容量のバッファによるプロトコル不整合を防ぐため。
 * @param value - 検証対象の値。
 * @returns 正常なバッファ、または未指定の場合 undefined。
 */
export function validateInferenceHealth(value: unknown): SharedArrayBuffer | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value instanceof SharedArrayBuffer && value.byteLength === 4) {
    return value;
  }
  throw new VectorError("E_PROTOCOL");
}

/**
 * 処理名: ヘルス状態公開
 * 処理概要: 指定されたヘルス状態を Atomics 経由でバッファに書き込み、待機側へ通知する。
 * 実装理由: 推論セッションの異常または終了をアトミックに伝達するため。
 * @param buffer - ヘルス状態共有バッファ (省略時は no-op)。
 * @param state - 設定するヘルス状態 (1=READY, 2=FAILED, 3=CLOSED)。
 */
export function publishInferenceHealth(
  buffer: SharedArrayBuffer | undefined,
  state: 1 | 2 | 3
): void {
  if (buffer === undefined) {
    return;
  }
  const view = new Int32Array(buffer, 0, 1);
  Atomics.store(view, 0, state);
  Atomics.notify(view, 0);
}

/**
 * 処理名: 推論準備状態確認
 * 処理概要: ヘルスバッファの値が READY (1) であることをアサートする。
 * 実装理由: 故障または未準備のセッションに対する推論要求を即時遮断するため。
 * @param buffer - ヘルス状態共有バッファ。
 */
export function assertInferenceReady(buffer: SharedArrayBuffer): void {
  const view = new Int32Array(buffer, 0, 1);
  const val = Atomics.load(view, 0);
  if (val !== HEALTH_READY) {
    throw new VectorError("E_INFERENCE");
  }
}
