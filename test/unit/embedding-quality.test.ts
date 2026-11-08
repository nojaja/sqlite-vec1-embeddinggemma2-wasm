import { evaluateEmbeddingQuality, type EmbeddingQualityPair } from "../../src/inference/embedding-quality";

/**
 * 処理名: 品質試験vector生成
 * 処理概要: 指定indexだけが1の768次元vectorを返す。
 * 実装理由: cosine 1と0を決定的に作るため。
 * @param index - 1を設定する次元。
 * @returns 固定単位vector。
 */
function qualityVector(index: number): Float32Array {
  const result = new Float32Array(768);
  result[index] = 1;
  return result;
}

/**
 * 処理名: 品質閾値合格検証
 * 処理概要: text/image双方の平均・最小cosineと件数を確認する。
 * 実装理由: G03 reportの環境非依存な集計契約を固定するため。
 */
function verifyQualityPass(): void {
  const pairs: EmbeddingQualityPair[] = [
    { id: "text-1", modality: "text", candidate: qualityVector(0), reference: qualityVector(0) },
    { id: "image-1", modality: "image", candidate: qualityVector(1), reference: qualityVector(1) }
  ];
  expect(evaluateEmbeddingQuality(pairs, { text: { mean: 0.98, each: 0.9 }, image: { mean: 0.96, each: 0.9 } })).toEqual({
    passed: true,
    text: { count: 1, mean: 1, minimum: 1, passed: true },
    image: { count: 1, mean: 1, minimum: 1, passed: true }
  });
}

/**
 * 処理名: 品質閾値不合格検証
 * 処理概要: 一件の低cosineが最小・平均gateを失敗させることを確認する。
 * 実装理由: 平均だけで個別劣化を隠さないため。
 */
function verifyQualityFailure(): void {
  const pairs: EmbeddingQualityPair[] = [
    { id: "text-1", modality: "text", candidate: qualityVector(0), reference: qualityVector(1) },
    { id: "image-1", modality: "image", candidate: qualityVector(1), reference: qualityVector(1) }
  ];
  const report = evaluateEmbeddingQuality(pairs, { text: { mean: 0.98, each: 0.9 }, image: { mean: 0.96, each: 0.9 } });
  expect(report.passed).toBe(false);
  expect(report.text).toEqual({ count: 1, mean: 0, minimum: 0, passed: false });
  expect(report.image.passed).toBe(true);
}

/**
 * 処理名: 品質入力拒否検証
 * 処理概要: 重複ID、欠損modality、異次元、非有限、ゼロvectorを拒否する。
 * 実装理由: 不完全fixtureを品質合格へ集計しないため。
 */
function verifyQualityInputRejection(): void {
  const valid: EmbeddingQualityPair = { id: "text-1", modality: "text", candidate: qualityVector(0), reference: qualityVector(0) };
  const thresholds = { text: { mean: 0.98, each: 0.9 }, image: { mean: 0.96, each: 0.9 } } as const;
  expect(() => evaluateEmbeddingQuality([valid, { ...valid }], thresholds)).toThrow("E_INPUT");
  expect(() => evaluateEmbeddingQuality([valid], thresholds)).toThrow("E_INPUT");
  expect(() => evaluateEmbeddingQuality([{ ...valid, candidate: new Float32Array(767) }, { ...valid, id: "image-1", modality: "image" }], thresholds)).toThrow("E_EMBEDDING_VALUE");
  expect(() => evaluateEmbeddingQuality([{ ...valid, candidate: new Float32Array(768).fill(Number.NaN) }, { ...valid, id: "image-1", modality: "image" }], thresholds)).toThrow("E_EMBEDDING_VALUE");
  expect(() => evaluateEmbeddingQuality([{ ...valid, candidate: new Float32Array(768) }, { ...valid, id: "image-1", modality: "image" }], thresholds)).toThrow("E_EMBEDDING_VALUE");
}

test("G03: text and image cosine thresholds pass", verifyQualityPass);
test("G03: per-item cosine degradation fails the gate", verifyQualityFailure);
test("G03: incomplete or corrupt quality inputs are rejected", verifyQualityInputRejection);