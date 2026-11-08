import type { ErrorCode } from "../errors";

/** bridge内部error IDと公開codeの唯一の対応表。 */
export const ERROR_CODES_BY_ID: Readonly<Record<number, ErrorCode>> = Object.freeze({
  1: "E_INPUT", 2: "E_TOKEN_LIMIT", 3: "E_IMAGE_FORMAT", 4: "E_IMAGE_LIMIT", 5: "E_EMBEDDING_VALUE",
  6: "E_INFERENCE", 7: "E_TIMEOUT", 8: "E_CANCELLED", 9: "E_MEMORY", 10: "E_PROTOCOL"
});

/**
 * 処理名: error ID取得
 * 処理概要: 公開codeからbridge内部IDを返す。未知codeはE_INFERENCE(6)にする。
 * 実装理由: 例外本文を送らず固定IDだけをSABへ公開するため。
 * @param code - 公開code。
 * @returns 内部ID。
 */
export function errorIdForCode(code: string): number {
  for (const [id, value] of Object.entries(ERROR_CODES_BY_ID)) if (value === code) return Number(id);
  return 6;
}

/** 致命的として扱うerror ID。 */
export const FATAL_ERROR_IDS: ReadonlySet<number> = new Set([5, 6, 9, 10]);
