import { embeddingSqlValue } from "../../src/official/functions";

test("official SQL: generic model validation precedes NULL and readiness", () => {
  expect(embeddingSqlValue("embedding", [null])).toBeNull();
  expect(embeddingSqlValue("embedding_query", [null, "embeddinggemma-2"])).toBeNull();
  for (const model of [null, "", "other", 1, "EmbeddingGemma-2"]) {
    expect(() => embeddingSqlValue("embedding", [null, model])).toThrow("E_INPUT");
  }
  expect(() => embeddingSqlValue("embedding", ["body"])).toThrow("E_EMBEDDING_NOT_READY");
});

test("official SQL: validates input and keeps document/query operations separate", () => {
  for (const value of [1, "", " ", "bad\0text", new Uint8Array(2)]) expect(() => embeddingSqlValue("embedding", [value])).toThrow("E_INPUT");
  const infer = jest.fn(() => new Uint8Array(3072));
  expect(embeddingSqlValue("embedding", ["body"], infer)).toHaveLength(3072);
  expect(infer).toHaveBeenLastCalledWith({ operation: "document", body: "body", title: undefined });
  embeddingSqlValue("embedding_query", ["body", "embeddinggemma-2"], infer);
  expect(infer).toHaveBeenLastCalledWith({ operation: "query", body: "body", title: undefined });
  embeddingSqlValue("gemma_embed_document", ["body", "title"], infer);
  expect(infer).toHaveBeenLastCalledWith({ operation: "document", body: "body", title: "title" });
});