import { VectorError, ErrorCode } from "../errors";
import { createResponseBuffer, waitResponse } from "../bridge/protocol";

/**
 * 処理名: 推論リクエスト送信ポート型
 * 処理概要: postMessage メソッドを持つメッセージ送信境界。
 */
export interface InferenceRequestPort {
  postMessage(message: unknown): void;
}

/**
 * 処理名: DB 埋め込み要求型
 * 処理概要: ジョブID、リクエストID、世代番号、操作種別、本文または画像を保持する型。
 */
export type DbEmbeddingRequest = {
  jobId: string;
  requestId: number;
  generation: number;
} & (
  | { operation: "query" | "document"; body: unknown; title?: unknown }
  | { operation: "image"; bytes: unknown; mime: unknown }
);

const ERROR_ID_MAP: Record<number, ErrorCode> = {
  1: "E_INPUT",
  2: "E_TOKEN_LIMIT",
  3: "E_IMAGE_FORMAT",
  4: "E_IMAGE_LIMIT",
  5: "E_EMBEDDING_VALUE",
  6: "E_INFERENCE",
  7: "E_TIMEOUT",
  8: "E_CANCELLED",
  9: "E_MEMORY",
  10: "E_PROTOCOL"
};

/**
 * 処理名: 埋め込み要求実行 (DBブリッジ)
 * 処理概要: 要求 envelope を検証し、Worker へ非同期要求を送信後、SAB で同期待機して結果 BLOB を返す。
 * 実装理由: 同期 SQLite UDF が非同期推論 Worker と安全・期限付き・独立コピーで連携するため。
 * @param port - 推論 Worker への送信ポート。
 * @param request - DB 埋め込み要求。
 * @param cancellationBuffer - キャンセル通知共有バッファ。
 * @param timeoutMs - タイムアウト時間 (ミリ秒)。
 * @returns 3072 バイトの Float32 BLOB、または NULL。
 */
export function requestEmbedding(
  port: InferenceRequestPort,
  request: DbEmbeddingRequest,
  cancellationBuffer: SharedArrayBuffer,
  timeoutMs: number
): Uint8Array | null {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new VectorError("E_PROTOCOL");
  }
  if (!(cancellationBuffer instanceof SharedArrayBuffer) || cancellationBuffer.byteLength !== 4) {
    throw new VectorError("E_PROTOCOL");
  }

  if (typeof request.jobId !== "string" || request.jobId.length === 0) {
    throw new VectorError("E_PROTOCOL");
  }
  if (!Number.isSafeInteger(request.requestId) || request.requestId < 1) {
    throw new VectorError("E_PROTOCOL");
  }
  if (!Number.isSafeInteger(request.generation) || request.generation < 0) {
    throw new VectorError("E_PROTOCOL");
  }

  // NULL 短絡
  if (request.operation !== "image" && request.body === null) {
    return null;
  }

  let input: Record<string, unknown>;
  if (request.operation === "image") {
    if (!(request.bytes instanceof Uint8Array)) {
      throw new VectorError("E_INPUT");
    }
    input = {
      bytes: new Uint8Array(request.bytes),
      mime: request.mime
    };
  } else {
    input = {
      text: request.body,
      title: request.title
    };
  }

  const responseBuffer = createResponseBuffer();
  const message = {
    protocolVersion: 1,
    jobId: request.jobId,
    requestId: request.requestId,
    generation: request.generation,
    operation: request.operation,
    input,
    responseBuffer
  };

  try {
    port.postMessage(message);
  } catch {
    throw new VectorError("E_INFERENCE");
  }

  const deadline = performance.now() + timeoutMs;
  const bridgeRes = waitResponse(responseBuffer, cancellationBuffer, deadline);

  if (bridgeRes.errorId !== 0) {
    const code = ERROR_ID_MAP[bridgeRes.errorId] ?? "E_PROTOCOL";
    throw new VectorError(code);
  }

  return new Uint8Array(bridgeRes.payload);
}
