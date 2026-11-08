import { StatementEmbeddingCache } from "../../src/inference/statement-embedding-cache";
import type { EmbeddingCall } from "../../src/official/functions";

const identity = { modelId: "embeddinggemma-2", revision: "fixed", fingerprint: "model", profile: "profile", backend: "wasm", runtimeGeneration: 1 };

/** 処理名: 正常vector生成。処理概要: 独立した正規化3072-byte BLOBを返す。実装理由: cacheの値検証を省略せず試験するため。
 * @returns 正規化BLOB。
 */
function validVector(): Uint8Array {
  const bytes = new Uint8Array(3072);
  new DataView(bytes.buffer).setFloat32(0, 1, true);
  return bytes;
}

/** 処理名: 文書要求生成。処理概要: 指定本文を文書operationへ正規化する。実装理由: LRUの期待推論回数を明確にするため。
 * @param body - 本文。
 * @returns 文書要求。
 */
function documentCall(body: string): EmbeddingCall { return { operation: "document", body, title: undefined }; }

test("statement cache: hits are copied and query/document/title remain separate", () => {
  const cache = new StatementEmbeddingCache(identity);
  const infer = jest.fn(validVector);
  const first = cache.resolve(documentCall("same"), infer)!;
  first[0] = 255;
  expect(cache.resolve(documentCall("same"), infer)).toEqual(validVector());
  cache.resolve({ operation: "query", body: "same", title: undefined }, infer);
  cache.resolve({ operation: "document", body: "same", title: "title" }, infer);
  cache.resolve({ operation: "document", body: "same", title: null }, infer);
  expect(infer).toHaveBeenCalledTimes(3);
  expect(cache.statistics()).toMatchObject({ hit: 2, miss: 3, actualInference: 3, entries: 3 });
});

test("statement cache: keeps ten entries and refreshes LRU on hit", () => {
  const cache = new StatementEmbeddingCache(identity);
  const infer = jest.fn(validVector);
  for (let index = 0; index < 10; index++) cache.resolve(documentCall(String(index)), infer);
  cache.resolve(documentCall("0"), infer);
  cache.resolve(documentCall("10"), infer);
  cache.resolve(documentCall("0"), infer);
  expect(infer).toHaveBeenCalledTimes(11);
  cache.resolve(documentCall("1"), infer);
  expect(infer).toHaveBeenCalledTimes(12);
  expect(cache.statistics()).toMatchObject({ entries: 10, eviction: 2 });
});

test("statement cache: compares image bytes, enforces byte capacity and bypasses oversized keys", () => {
  const cache = new StatementEmbeddingCache(identity, 3400);
  const infer = jest.fn(validVector);
  const image: EmbeddingCall = { operation: "image", bytes: new Uint8Array([1, 2]), mime: "image/png" };
  cache.resolve(image, infer);
  image.bytes[0] = 9;
  cache.resolve({ ...image, bytes: new Uint8Array([1, 2]) }, infer);
  expect(infer).toHaveBeenCalledTimes(1);
  cache.resolve(image, infer);
  expect(infer).toHaveBeenCalledTimes(2);
  expect(cache.statistics().bytes).toBeLessThanOrEqual(3400);
  cache.resolve(documentCall("x".repeat(4000)), infer);
  cache.resolve(documentCall("x".repeat(4000)), infer);
  expect(infer).toHaveBeenCalledTimes(4);
});

test("statement cache: excludes failures, NULL and malformed vectors", () => {
  const cache = new StatementEmbeddingCache(identity);
  const failure = jest.fn(() => { throw new Error("E_INFERENCE"); });
  expect(() => cache.resolve(documentCall("bad"), failure)).toThrow("E_INFERENCE");
  expect(cache.resolve(documentCall("null"), () => null)).toBeNull();
  for (const invalid of [new Uint8Array(3), new Uint8Array(3072)]) {
    expect(() => cache.resolve(documentCall("invalid"), () => invalid)).toThrow("E_EMBEDDING_VALUE");
  }
  expect(cache.statistics().entries).toBe(0);
});

test("statement cache: validates deadline on hits and never revives disposed execution", () => {
  const check = jest.fn();
  const cache = new StatementEmbeddingCache(identity, 32 * 1024 * 1024, check);
  const infer = jest.fn(validVector);
  cache.resolve(documentCall("same"), infer);
  check.mockImplementation(() => { throw new Error("E_TIMEOUT"); });
  expect(() => cache.resolve(documentCall("same"), infer)).toThrow("E_TIMEOUT");
  expect(infer).toHaveBeenCalledTimes(1);
  cache.dispose();
  check.mockReset();
  expect(() => cache.resolve(documentCall("same"), infer)).toThrow("E_PROTOCOL");
  expect(cache.statistics().entries).toBe(0);
});

test("statement cache: evicts at the real 32MiB boundary and rejects nonfinite output", () => {
  const cache = new StatementEmbeddingCache(identity);
  const infer = jest.fn(validVector);
  const first = new Uint8Array(20 * 1024 * 1024);
  const second = new Uint8Array(20 * 1024 * 1024); second[0] = 1;
  cache.resolve({ operation: "image", bytes: first, mime: "image/png" }, infer);
  cache.resolve({ operation: "image", bytes: second, mime: "image/png" }, infer);
  expect(cache.statistics()).toMatchObject({ entries: 1, eviction: 1 });
  expect(cache.statistics().bytes).toBeLessThanOrEqual(32 * 1024 * 1024);
  const invalid = validVector(); new DataView(invalid.buffer).setFloat32(4, Infinity, true);
  expect(() => cache.resolve(documentCall("invalid"), () => invalid)).toThrow("E_EMBEDDING_VALUE");
});