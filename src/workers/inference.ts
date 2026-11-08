import { errorIdForCode, FATAL_ERROR_IDS } from "../bridge/error-ids";
import { publishResponse } from "../bridge/protocol";
import type { EmbedRequest } from "../inference/engine";

/** handlerが必要とするengine境界。 */
export interface InferenceHandlerEngine { embed(request: EmbedRequest): Promise<Uint8Array | null> }

/**
 * 処理名: 応答bufferの取得
 * 処理概要: messageからSharedArrayBufferだけを取り出す。
 * 実装理由: 不正messageへ応答先を推測しないため。
 * @param message - 受信message。
 * @returns bufferまたはundefined。
 */
function responseBufferOf(message: unknown): SharedArrayBuffer | undefined {
  const buffer = (message as { responseBuffer?: unknown } | null)?.responseBuffer;
  return buffer instanceof SharedArrayBuffer ? buffer : undefined;
}

/**
 * 処理名: エラー公開
 * 処理概要: 固定IDだけを空payloadでSABへ公開し、致命的かを返す。
 * 実装理由: 例外本文や入力を共有応答へ出さないため。
 * @param buffer - 応答buffer。
 * @param code - 公開code。
 * @returns 致命的ならtrue。
 */
function publishFailure(buffer: SharedArrayBuffer | undefined, code: string): boolean {
  const id = errorIdForCode(code);
  if (buffer !== undefined) publishResponse(buffer, new Uint8Array(0), id);
  return FATAL_ERROR_IDS.has(id);
}

/**
 * 処理名: request envelope検証
 * 処理概要: version、jobId、requestId、operation、inputを確認する。
 * 実装理由: 不明な形式を推論要求として解釈しないため。
 * @param message - 受信message。
 * @returns 有効か。
 */
function validEnvelope(message: Record<string, unknown>): boolean {
  return message.protocolVersion === 1 && typeof message.jobId === "string" && message.jobId.length > 0
    && Number.isSafeInteger(message.requestId) && (message.requestId as number) >= 1
    && ["query", "document", "image"].includes(message.operation as string)
    && typeof message.input === "object" && message.input !== null;
}

/**
 * 処理名: 推論要求処理
 * 処理概要: 世代を確認してengineを実行し、結果をSABへ公開する。
 * 実装理由: 要求とmessage順序を切り離し、古い世代を無視するため。
 * @param engine - 推論engine。
 * @param message - 受信message。
 * @param generation - 現在の世代。
 * @returns Workerを故障させるべきならtrue。
 */
export async function handleInferenceRequest(engine: InferenceHandlerEngine, message: unknown, generation: number): Promise<boolean> {
  const buffer = responseBufferOf(message);
  const record = (message ?? {}) as Record<string, unknown>;
  if (Number.isSafeInteger(record.generation) && record.generation !== generation) return false;
  if (!validEnvelope(record) || record.generation !== generation) return publishFailure(buffer, "E_PROTOCOL");
  const input = record.input as Record<string, unknown>;
  const operation = record.operation as "query" | "document" | "image";
  const request: EmbedRequest = operation === "image"
    ? { operation, bytes: input.bytes instanceof ArrayBuffer ? new Uint8Array(input.bytes) : input.bytes, mime: input.mime }
    : { operation, body: input.text, title: input.title };
  try {
    const result = await engine.embed(request);
    if (result === null || buffer === undefined) return publishFailure(buffer, "E_PROTOCOL");
    publishResponse(buffer, result);
    return false;
  } catch (error) {
    return publishFailure(buffer, (error as { code?: string } | null)?.code ?? "E_INFERENCE");
  }
}
