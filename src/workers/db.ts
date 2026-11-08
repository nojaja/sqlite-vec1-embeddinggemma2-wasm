import { readResponse, waitResponse, createResponseBuffer } from "../bridge/protocol";
import { ERROR_CODES_BY_ID } from "../bridge/error-ids";
import { VectorError } from "../errors";

/** 推論Workerへ送るport。 */
export interface InferenceRequestPort { postMessage(message: unknown): void }

/** DB ownerからの推論要求。 */
export type DbEmbeddingRequest = { jobId: string; requestId: number; generation: number } & (
  | { operation: "query" | "document"; body: unknown; title?: unknown }
  | { operation: "image"; bytes: unknown; mime: unknown }
);

/**
 * 処理名: embedding同期要求
 * 処理概要: envelopeを検証して推論Workerへ送り、SABで同期的に結果を待つ。
 * 実装理由: 同期UDFからPromiseを返さずにembeddingを得るため。
 * @param port - 推論要求port。
 * @param request - 要求内容。
 * @param cancellationBuffer - cancel flag。
 * @param timeoutMs - 期限(ms)。
 * @returns 3072 byteのBLOBまたはNULL。
 */
export function requestEmbedding(port: InferenceRequestPort, request: DbEmbeddingRequest, cancellationBuffer: SharedArrayBuffer, timeoutMs: number): Uint8Array | null {
  const validEnvelope = typeof request.jobId === "string" && request.jobId.length > 0
    && Number.isSafeInteger(request.requestId) && request.requestId >= 1
    && Number.isSafeInteger(request.generation) && request.generation >= 0
    && Number.isFinite(timeoutMs) && timeoutMs >= 0;
  if (!validEnvelope) throw new VectorError("E_PROTOCOL");
  let input: Record<string, unknown>;
  if (request.operation === "image") {
    if (!(request.bytes instanceof Uint8Array)) throw new VectorError("E_INPUT");
    input = { bytes: request.bytes.slice(), mime: request.mime };
  } else {
    if (request.body === null) return null;
    input = { text: request.body, title: request.title };
  }
  const responseBuffer = createResponseBuffer();
  const deadline = performance.now() + timeoutMs;
  try {
    port.postMessage({ protocolVersion: 1, jobId: request.jobId, requestId: request.requestId, generation: request.generation, operation: request.operation, input, responseBuffer });
  } catch {
    throw new VectorError("E_INFERENCE");
  }
  const response = waitResponse(responseBuffer, cancellationBuffer, deadline);
  if (response.errorId !== 0) throw new VectorError(ERROR_CODES_BY_ID[response.errorId] ?? "E_PROTOCOL");
  return readResponse(responseBuffer).payload;
}
