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

export type EmbeddableEngine = {
  embed: (req: EngineRequest) => Promise<Uint8Array | null>;
};

export type EngineResolver =
  | EmbeddableEngine
  | ReadonlyMap<string, EmbeddableEngine>
  | ((model?: string) => EmbeddableEngine | Promise<EmbeddableEngine | undefined> | undefined);

/**
 * 処理名: 推論エンジン解決
 * 処理概要: 単一エンジン、Map、または同期/非同期リゾルバ関数から要求モデルに対応するエンジンを取得する。
 * @param engineOrResolver - エンジンまたは解決手段。
 * @param model - 要求モデル名。
 * @returns 対象の推論エンジン、または未解決時 undefined。
 */
async function resolveTargetEngine(
  engineOrResolver: EngineResolver,
  model?: string
): Promise<EmbeddableEngine | undefined> {
  if (typeof engineOrResolver === "function") {
    return await engineOrResolver(model);
  }
  if (engineOrResolver instanceof Map) {
    if (model !== undefined) {
      return engineOrResolver.get(model);
    }
    return engineOrResolver.values().next().value;
  }
  return engineOrResolver as EmbeddableEngine;
}

/**
 * 処理名: 推論要求ハンドラー
 * 処理概要: 要求メッセージの世代とプロトコルを検証し、推論エンジンを実行して SAB へ応答を公開する。
 * 実装理由: 異世代要求の無視、例外本文の秘匿、致命的エラー（5/6/9/10）の検知・通知、およびモデル別エンジン振り分けを行うため。
 * @param engine - embed メソッドを持つ推論エンジンまたはモデル別エンジンリゾルバ。
 * @param message - 受信したメッセージオブジェクト。
 * @param generation - 現在の Worker 実行世代。
 * @returns 致命的エラーが発生した場合は true、正常または軽微エラー時は false。
 */
export async function handleInferenceRequest(
  engine: EngineResolver,
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
    const requestedModel = typeof msg.model === "string" ? msg.model : undefined;
    const targetEngine = await resolveTargetEngine(engine, requestedModel);
    if (!targetEngine) {
      publishResponse(responseBuffer, new Uint8Array(0), 1);
      return false;
    }
    const res = await targetEngine.embed(engineReq);
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
