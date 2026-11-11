import { VectorError } from "../errors";

/**
 * 処理名: 埋め込み品質評価ペア型
 * 処理概要: 評価 ID、モダリティ、推論結果候補、参照正解ベクトルを保持する。
 */
export interface EmbeddingQualityPair {
  id: string;
  modality: "text" | "image";
  candidate: Float32Array;
  reference: Float32Array;
}

/**
 * 処理名: モダリティ別閾値設定型
 * 処理概要: 平均類似度 (mean) と各件最小類似度 (each) の下限を定義する。
 */
export interface ModalityThreshold {
  mean: number;
  each: number;
}

/**
 * 処理名: 品質閾値設定型
 * 処理概要: テキストおよび画像の閾値を保持する構造体。
 */
export interface QualityThresholds {
  text: ModalityThreshold;
  image: ModalityThreshold;
}

/**
 * 処理名: モダリティ別品質集計結果型
 * 処理概要: 評価件数、平均コサイン類似度、最小類似度、合否判定を保持する。
 */
export interface ModalityReport {
  count: number;
  mean: number;
  minimum: number;
  passed: boolean;
}

/**
 * 処理名: 総合品質レポート型
 * 処理概要: 全体合否およびモダリティ別レポートを保持する構造体。
 */
export interface EmbeddingQualityReport {
  passed: boolean;
  text: ModalityReport;
  image: ModalityReport;
}

/**
 * 処理名: コサイン類似度計算
 * 処理概要: 2つの 768 次元ベクトルのコサイン類似度を算出する。
 * 実装理由: NaN、無限大、ゼロノルムを厳格に検知し排除するため。
 * @param a - ベクトル A。
 * @param b - ベクトル B。
 * @returns コサイン類似度 (-1..1)。
 */
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== 768 || b.length !== 768) {
    throw new VectorError("E_EMBEDDING_VALUE");
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < 768; i++) {
    const va = a[i]!;
    const vb = b[i]!;
    if (!Number.isFinite(va) || !Number.isFinite(vb)) {
      throw new VectorError("E_EMBEDDING_VALUE");
    }
    dot += va * vb;
    normA += va * va;
    normB += vb * vb;
  }
  normA = Math.sqrt(normA);
  normB = Math.sqrt(normB);
  if (normA < 1e-12 || normB < 1e-12) {
    throw new VectorError("E_EMBEDDING_VALUE");
  }
  return dot / (normA * normB);
}

/**
 * 処理名: 埋め込み品質評価実行
 * 処理概要: ペア一覧を検証し、テキスト・画像それぞれの平均・最小コサイン類似度を集計して判定する。
 * 実装理由: 個別の精度劣化を平均で隠蔽することなく、厳格な品質ゲートを保証するため。
 * @param pairs - 評価ペア配列。
 * @param thresholds - 閾値定義。
 * @returns 評価結果レポート。
 */
export function evaluateEmbeddingQuality(
  pairs: readonly EmbeddingQualityPair[],
  thresholds: QualityThresholds
): EmbeddingQualityReport {
  const seenIds = new Set<string>();
  const textSimilarities: number[] = [];
  const imageSimilarities: number[] = [];

  for (const pair of pairs) {
    if (!pair || typeof pair.id !== "string" || pair.id.trim().length === 0) {
      throw new VectorError("E_INPUT");
    }
    if (seenIds.has(pair.id)) {
      throw new VectorError("E_INPUT"); // 重複 ID 拒絶
    }
    seenIds.add(pair.id);

    const sim = cosineSimilarity(pair.candidate, pair.reference);
    if (pair.modality === "text") {
      textSimilarities.push(sim);
    } else if (pair.modality === "image") {
      imageSimilarities.push(sim);
    } else {
      throw new VectorError("E_INPUT");
    }
  }

  if (textSimilarities.length === 0 || imageSimilarities.length === 0) {
    throw new VectorError("E_INPUT"); // 両モダリティ必須
  }

  /**
   * 処理名: モダリティ集計ヘルパー
   * 処理概要: 類似度配列から件数・平均・最小値・合否を算出する。
   * @param sims - 類似度配列。
   * @param th - 閾値。
   * @returns モダリティ別集計結果。
   */
  function aggregate(sims: readonly number[], th: ModalityThreshold): ModalityReport {
    let sum = 0;
    let min = Infinity;
    for (const s of sims) {
      sum += s;
      if (s < min) min = s;
    }
    const mean = sum / sims.length;
    const passed = mean >= th.mean && min >= th.each;
    return {
      count: sims.length,
      mean,
      minimum: min,
      passed
    };
  }

  const textReport = aggregate(textSimilarities, thresholds.text);
  const imageReport = aggregate(imageSimilarities, thresholds.image);

  return {
    passed: textReport.passed && imageReport.passed,
    text: textReport,
    image: imageReport
  };
}
