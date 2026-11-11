import { ErrorCode } from "../errors";
import { publishResponse } from "../bridge/protocol";
import { EngineRequest } from "../inference/engine";

const CODE_TO_ERROR_ID: Record<string, number> = {
  E_INPUT: 1,
  E_TOKEN_LIMIT: 2,
  E_IMAGE_FORMAT: 3,
  E_IMAGE_LIMIT: 4,
  E_EMBEDDING_VALUE: 5,
  E_INFERENCE: 6,
  E_TIMEOUT: 7,
  E_CANCELLED: 8,
  E_MEMORY: 9,
  E_PROTOCOL: 10
};

/**
 * 処理名: 推論要求ハンドラー
 * 処理概要: 要求メッセージの世代とプロトコルを検証し、推論エンジンを実行して SAB へ応答を公開する。
 * 実装理由: 異世代要求の無視、例外本文の秘匿、致命的エラー（5/6/9/10）の検知・通知を行うため。
 * @param engine - embed メソッドを持つ推論エンジン。
 * @param message - 受信したメッセージオブジェクト。
 * @param generation - 現在の Worker 実行世代。
 * @returns 致命的エラーが発生した場合は true、正常または軽微エラー時は false。
 */
export async function handleInferenceRequest(
  engine: { embed: (req: EngineRequest) => Promise<Uint8Array | null> },
  message: unknown,
  generation: number
): Promise<boolean> {
  const msg = message as Record<string, unknown> | null;
  if (!msg || typeof msg !== "object") {
    return true;
  }

  // 異世代要求は応答せず無視
  if (msg.generation !== generation) {
    return false;
  }

  const responseBuffer = msg.responseBuffer as SharedArrayBuffer | undefined;

  // プロトコル検証
  if (msg.protocolVersion !== 1 || !responseBuffer) {
    if (responseBuffer instanceof SharedArrayBuffer && responseBuffer.byteLength === 8192) {
      publishResponse(responseBuffer, new Uint8Array(0), 10);
    }
    return true; // 致命的プロトコル違反
  }

  const operation = msg.operation as string;
  const input = msg.input as Record<string, unknown> | undefined;
  let engineReq: EngineRequest;

  if (operation === "image") {
    let rawBytes = input?.bytes;
    if (rawBytes instanceof ArrayBuffer) {
      rawBytes = new Uint8Array(rawBytes);
    }
    engineReq = {
      operation: "image",
      bytes: rawBytes,
      mime: input?.mime
    };
  } else if (operation === "query" || operation === "document") {
    engineReq = {
      operation,
      body: input?.text,
      title: input?.title
    };
  } else {
    publishResponse(responseBuffer, new Uint8Array(0), 10);
    return true;
  }

  try {
    const res = await engine.embed(engineReq);
    if (res === null) {
      publishResponse(responseBuffer, new Uint8Array(0), 10);
      return true;
    }
    publishResponse(responseBuffer, res);
    return false;
  } catch (err: unknown) {
    const code = ((err as { code?: ErrorCode })?.code ?? "E_INFERENCE") as string;
    const errorId = CODE_TO_ERROR_ID[code] ?? 6;
    publishResponse(responseBuffer, new Uint8Array(0), errorId);

    // 致命的エラー ID: 5 (E_EMBEDDING_VALUE), 6 (E_INFERENCE), 9 (E_MEMORY), 10 (E_PROTOCOL)
    const isFatal = errorId === 5 || errorId === 6 || errorId === 9 || errorId === 10;
    return isFatal;
  }
}
