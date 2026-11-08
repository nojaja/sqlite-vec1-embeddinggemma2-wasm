import { assertTokenLimit, embeddingToBlob, formatTextInput } from "../../src/inference/profile";

/**
 * 処理名: 正規化BLOB検証
 * 処理概要: 768次元の出力長、LE格納、L2 normを検証する。
 * 実装理由: vec1へ型やendiannessの異なる値を保存しないため。
 */
function verifyNormalizedBlob(): void {
  const input = new Float32Array(768);
  input[0] = 3;
  input[1] = 4;
  const blob = embeddingToBlob(input, [1, 768]);
  expect(blob).toBeInstanceOf(Uint8Array);
  expect(blob.byteLength).toBe(3072);
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  expect(view.getFloat32(0, true)).toBeCloseTo(0.6, 6);
  expect(view.getFloat32(4, true)).toBeCloseTo(0.8, 6);
  let squaredNorm = 0;
  for (let index = 0; index < 768; index += 1) squaredNorm += view.getFloat32(index * 4, true) ** 2;
  expect(Math.abs(Math.sqrt(squaredNorm) - 1)).toBeLessThanOrEqual(1e-5);
  input.fill(0);
  expect(view.getFloat32(0, true)).toBeCloseTo(0.6, 6);
}

/**
 * 処理名: 不正embedding検証
 * 処理概要: shape、要素数、非有限値、ゼロnormを拒否する。
 * 実装理由: 推論の異常出力を永続化させないため。
 * @param values - 検査する要素配列。
 * @param shape - tensor shape。
 */
function verifyRejectedEmbedding(values: Float32Array, shape: number[]): void {
  expect(embeddingToBlob.bind(undefined, values, shape)).toThrow("E_EMBEDDING_VALUE");
}

/**
 * 処理名: prefix契約確認
 * 処理概要: queryとdocumentの書式および無変換入力を確認する。
 * 実装理由: 同じ本文でもtaskに応じた入力を維持するため。
 */
function verifyTextPrefixes(): void {
  expect(formatTextInput("query", "  A\nB  ", undefined, [])).toBe("task: search result | query:   A\nB  ");
  expect(formatTextInput("document", "body", undefined, [])).toBe("title: none | text: body");
  expect(formatTextInput("document", "body", null, [])).toBe("title: none | text: body");
  expect(formatTextInput("document", "body", "", [])).toBe("title: none | text: body");
  expect(formatTextInput("document", "body", "title", [])).toBe("title: title | text: body");
  expect(formatTextInput("query", null, 7, [])).toBeNull();
}

/**
 * 処理名: 不正テキスト検証
 * 処理概要: SQL型、不正文字、special token、UTF-8上限を検証する。
 * 実装理由: processorに暗黙変換や想定外の画像placeholderを渡さないため。
 * @param operation - queryまたはdocument。
 * @param body - SQL入力本文。
 * @param title - SQL入力title。
 * @param tokens - tokenizer由来special token。
 */
function verifyRejectedText(operation: "query" | "document", body: unknown, title: unknown, tokens: readonly string[]): void {
  expect(formatTextInput.bind(undefined, operation, body, title, tokens)).toThrow("E_INPUT");
}

test("R03/R04: normalized 768-dimensional little-endian independent BLOB", verifyNormalizedBlob);
test.each([
  [new Float32Array(768), [1, 768]],
  [new Float32Array(767).fill(1), [1, 768]],
  [new Float32Array(768).fill(1), [768]],
  [new Float32Array(768).fill(1), [2, 768]],
  [new Float32Array(768).fill(Number.NaN), [1, 768]],
  [new Float32Array(768).fill(Number.POSITIVE_INFINITY), [1, 768]],
  [new Float32Array(768).fill(1e-15), [1, 768]]
])("R03/R04: rejects invalid output %#", verifyRejectedEmbedding);
test("R03: exact query/document prefixes and SQL NULL", verifyTextPrefixes);

/**
 * 処理名: 最終token上限検証
 * 処理概要: processor出力の境界値と不正なcountを確認する。
 * 実装理由: 文字数による推測や自動切詰めで上限を隠さないため。
 */
function verifyTokenBoundary(): void {
  assertTokenLimit(0);
  assertTokenLimit(1);
  assertTokenLimit(2048);
  expect(assertTokenLimit.bind(undefined, 2049)).toThrow("E_TOKEN_LIMIT");
  for (const count of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(assertTokenLimit.bind(undefined, count)).toThrow("E_PROTOCOL");
  }
}

test("R03: final token count boundary", verifyTokenBoundary);
test.each<["query" | "document", unknown, unknown, readonly string[]]>([
  ["query", undefined, undefined, []],
  ["query", 1, undefined, []],
  ["query", "", undefined, []],
  ["query", " \n\t", undefined, []],
  ["query", "body\0", undefined, []],
  ["query", "body<|image|>", undefined, ["<|image|>"]],
  ["document", "body", "<special>", ["<special>"]],
  ["document", "body", 1, []],
  ["document", "body", "a".repeat(1025), []],
  ["document", "あ".repeat(349526), undefined, []]
])("R03: rejects invalid text %#", verifyRejectedText);