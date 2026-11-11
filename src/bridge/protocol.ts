import { VectorError } from "../errors";

/**
 * 処理名: ブリッジレスポンス型定義
 * 処理概要: 同期ブリッジ応答のペイロードとエラーIDを保持する型。
 * 実装理由: 呼出し元へ型安全に応答結果を引き渡すため。
 */
export interface BridgeResponse {
  payload: Uint8Array;
  errorId: number;
}

/**
 * 処理名: プロトコルバッファ定数定義
 * 処理概要: SABの総バイト長、ヘッダーオフセット、プロトコルバージョン、状態コードを定義する。
 * 実装理由: 排他制御およびデータ検証時の決定論的境界を保証するため。
 */
const BUFFER_BYTE_LENGTH = 8192;
const HEADER_INT32_COUNT = 8;
const HEADER_BYTE_LENGTH = 32;
const PROTOCOL_VERSION = 1;

const STATE_PENDING = 0;
const STATE_WRITING = 1;
const STATE_OK = 2;
const STATE_ERROR = 3;
const STATE_ABANDONED = 4;

/**
 * 処理名: 応答バッファ生成
 * 処理概要: 8192 バイトの SharedArrayBuffer を割り当て、初期プロトコルヘッダーを設定する。
 * 実装理由: 要求ごとに独立した使い捨てバッファを用意し、古い書き込みの混入を防止するため。
 * @returns 初期化された 8192 バイトの SharedArrayBuffer。
 */
export function createResponseBuffer(): SharedArrayBuffer {
  const sab = new SharedArrayBuffer(BUFFER_BYTE_LENGTH);
  const header = new Int32Array(sab, 0, HEADER_INT32_COUNT);
  Atomics.store(header, 0, STATE_PENDING);
  Atomics.store(header, 4, PROTOCOL_VERSION);
  return sab;
}

/**
 * 処理名: 応答公開
 * 処理概要: CAS により書き込み権を取得後、ペイロードとヘッダーを書き込み、完了状態へ遷移させて待機側へ通知する。
 * 実装理由: 放棄済み要求への無効な書き込みを拒否し、決定論的に結果を公開するため。
 * @param buffer - 応答用 SharedArrayBuffer。
 * @param payload - 書き込むデータペイロード。
 * @param errorId - 成功時は 0、エラー時は 1..10 の固定エラーID。
 * @returns 公開が成立した場合 true、既に放棄されている場合 false。
 */
export function publishResponse(
  buffer: SharedArrayBuffer,
  payload: Uint8Array,
  errorId = 0
): boolean {
  if (buffer.byteLength !== BUFFER_BYTE_LENGTH) {
    throw new VectorError("E_PROTOCOL");
  }
  if (errorId === 0) {
    if (payload.byteLength !== 3072) {
      throw new VectorError("E_PROTOCOL");
    }
  } else {
    if (errorId < 1 || errorId > 10 || payload.byteLength > 4096) {
      throw new VectorError("E_PROTOCOL");
    }
  }

  const header = new Int32Array(buffer, 0, HEADER_INT32_COUNT);
  const acquired = Atomics.compareExchange(header, 0, STATE_PENDING, STATE_WRITING);
  if (acquired !== STATE_PENDING) {
    return false;
  }

  new Uint8Array(buffer, HEADER_BYTE_LENGTH).set(payload);

  header[1] = payload.byteLength;
  header[2] = errorId;
  header[3] = errorId === 0 ? 768 : 0;
  header[4] = PROTOCOL_VERSION;
  header[5] = 0;
  header[6] = 0;
  header[7] = 0;

  const targetState = errorId === 0 ? STATE_OK : STATE_ERROR;
  const committed = Atomics.compareExchange(header, 0, STATE_WRITING, targetState);
  if (committed !== STATE_WRITING) {
    return false;
  }

  Atomics.notify(header, 0);
  return true;
}

/**
 * 処理名: 応答読み取り
 * 処理概要: 終端状態 (OK/ERROR) を確認し、ヘッダーの整合性を検証した上でペイロードの複製を返す。
 * 実装理由: 破損ヘッダーを拒否し、外部変更から保護された独立バッファを返却するため。
 * @param buffer - 応答用 SharedArrayBuffer。
 * @returns 読み取られた BridgeResponse。
 */
export function readResponse(buffer: SharedArrayBuffer): BridgeResponse {
  if (buffer.byteLength !== BUFFER_BYTE_LENGTH) {
    throw new VectorError("E_PROTOCOL");
  }
  const header = new Int32Array(buffer, 0, HEADER_INT32_COUNT);
  const state = Atomics.load(header, 0);
  if (state !== STATE_OK && state !== STATE_ERROR) {
    throw new VectorError("E_PROTOCOL");
  }

  const payloadLen = header[1];
  const errorId = header[2];
  const dim = header[3];
  const version = header[4];
  if (version !== PROTOCOL_VERSION || header[5] !== 0 || header[6] !== 0 || header[7] !== 0) {
    throw new VectorError("E_PROTOCOL");
  }

  if (state === STATE_OK) {
    if (payloadLen !== 3072 || errorId !== 0 || dim !== 768) {
      throw new VectorError("E_PROTOCOL");
    }
  } else {
    if (payloadLen < 0 || payloadLen > 4096 || errorId < 1 || errorId > 10 || dim !== 0) {
      throw new VectorError("E_PROTOCOL");
    }
  }

  const payloadBytes = new Uint8Array(buffer, HEADER_BYTE_LENGTH, payloadLen);
  const payloadCopy = new Uint8Array(payloadLen);
  payloadCopy.set(payloadBytes);

  return { payload: payloadCopy, errorId };
}

/**
 * 処理名: 応答放棄
 * 処理概要: 応答バッファを ABANDONED 状態へ遷移させ、後続の書き込みを拒否する。
 * 実装理由: タイムアウトやキャンセル時に古いタスクが後続要求を汚染しないようにするため。
 * @param buffer - 応答用 SharedArrayBuffer。
 * @returns 放棄が成立した場合 true、既に確定済みの場合 false。
 */
export function abandonResponse(buffer: SharedArrayBuffer): boolean {
  if (buffer.byteLength !== BUFFER_BYTE_LENGTH) {
    throw new VectorError("E_PROTOCOL");
  }
  const header = new Int32Array(buffer, 0, HEADER_INT32_COUNT);
  while (true) {
    const current = Atomics.load(header, 0);
    if (current === STATE_OK || current === STATE_ERROR) {
      return false;
    }
    if (current === STATE_ABANDONED) {
      return true;
    }
    if (current === STATE_PENDING || current === STATE_WRITING) {
      const prev = Atomics.compareExchange(header, 0, current, STATE_ABANDONED);
      if (prev === current) {
        return true;
      }
    } else {
      throw new VectorError("E_PROTOCOL");
    }
  }
}

/**
 * 処理名: 応答待機
 * 処理概要: Atomics.wait を用いて応答完了を同期待機し、キャンセル・デッドラインを定期的に検査する。
 * 実装理由: 同期SQL UDFが推論Workerの非同期応答を安全かつ期限付きで受け取るため。
 * @param buffer - 応答用 SharedArrayBuffer。
 * @param cancellation - キャンセル通知フラグ用 4 バイト SharedArrayBuffer。
 * @param deadline - 単調時刻ベースのデッドライン (ミリ秒)。
 * @returns 読み取られた BridgeResponse。
 */
export function waitResponse(
  buffer: SharedArrayBuffer,
  cancellation: SharedArrayBuffer,
  deadline: number
): BridgeResponse {
  if (buffer.byteLength !== BUFFER_BYTE_LENGTH) {
    throw new VectorError("E_PROTOCOL");
  }
  if (!(cancellation instanceof SharedArrayBuffer) || cancellation.byteLength !== 4) {
    throw new VectorError("E_PROTOCOL");
  }
  if (typeof deadline !== "number" || !Number.isFinite(deadline)) {
    throw new VectorError("E_PROTOCOL");
  }

  const header = new Int32Array(buffer, 0, HEADER_INT32_COUNT);
  const cancelView = new Int32Array(cancellation, 0, 1);

  while (true) {
    if (Atomics.load(cancelView, 0) === 1) {
      abandonResponse(buffer);
      throw new VectorError("E_CANCELLED");
    }

    const state = Atomics.load(header, 0);
    if (state === STATE_ABANDONED) {
      throw new VectorError("E_CANCELLED");
    }
    if (state === STATE_OK || state === STATE_ERROR) {
      return readResponse(buffer);
    }

    const now = performance.now();
    if (now >= deadline) {
      abandonResponse(buffer);
      throw new VectorError("E_TIMEOUT");
    }

    const remaining = Math.min(50, Math.max(1, Math.ceil(deadline - now)));
    Atomics.wait(header, 0, state, remaining);
  }
}
