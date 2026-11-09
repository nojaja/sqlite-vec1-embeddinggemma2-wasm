import { VectorError } from "../errors";
import { EMBEDDING_DIMENSION } from "./profile";

/**
 * 処理名: 埋め込み品質比較ペアインターフェース
 * 処理概要: 識別ID、モダリティ種別、候補ベクトル、参照ベクトルを定義する。
 * 実装理由: 候補と参照のペアごとのコサイン類似度検証を行うため。
 */
export interface EmbeddingQualityPair { id: string; modality: "text" | "image"; candidate: Float32Array; reference: Float32Array }

/**
 * 処理名: 埋め込み品質閾値制限インターフェース
 * 処理概要: 平均値および個別最小値に対する類似度閾値を定義する。
 * 実装理由: 各モダリティの許容誤差判定基準を保持するため。
 */
export interface EmbeddingThresholdLimit {
  mean: number;
  each: number;
}

/**
 * 処理名: モダリティ別品質閾値インターフェース
 * 処理概要: テキストおよび画像それぞれの類似度閾値設定を保持する。
 * 実装理由: モダリティごとに異なる品質要件を適用するため。
 */
export interface EmbeddingQualityThresholds { text: EmbeddingThresholdLimit; image: EmbeddingThresholdLimit }

/**
 * 処理名: モダリティ別品質統計インターフェース
 * 処理概要: 検証件数、平均類似度、最小類似度、判定結果を保持する。
 * 実装理由: モダリティごとの集計統計情報を表現するため。
 */
export interface EmbeddingQualityStat { count: number; mean: number; minimum: number; passed: boolean }

/**
 * 処理名: 埋め込み品質レポートインターフェース
 * 処理概要: 全体合否判定およびテキスト・画像それぞれの統計結果を定義する。
 * 実装理由: 品質検証結果をレポートとして構造化するため。
 */
export interface EmbeddingQualityReport { passed: boolean; text: EmbeddingQualityStat; image: EmbeddingQualityStat }

/**
 * 処理名: vector検証
 * 処理概要: 768次元・有限・非ゼロを確認しnormを返す。
 * 実装理由: 不正vectorを品質集計へ入れないため。
 * @param vector - 対象vector。
 * @returns L2 norm。
 */
function vectorNorm(vector: Float32Array): number {
  if (vector.length !== EMBEDDING_DIMENSION) throw new VectorError("E_EMBEDDING_VALUE");
  let squared = 0;
  for (const value of vector) {
    if (!Number.isFinite(value)) throw new VectorError("E_EMBEDDING_VALUE");
    squared += value * value;
  }
  if (squared <= 0) throw new VectorError("E_EMBEDDING_VALUE");
  return Math.sqrt(squared);
}

/**
 * 処理名: cosine類似度
 * 処理概要: 候補と参照の独立cosineを求める。
 * 実装理由: 平均だけで個別劣化を隠さないため。
 * @param pair - 比較対象。
 * @returns cosine。
 */
function cosine(pair: EmbeddingQualityPair): number {
  const left = vectorNorm(pair.candidate);
  const right = vectorNorm(pair.reference);
  let dot = 0;
  for (let index = 0; index < EMBEDDING_DIMENSION; index += 1) dot += (pair.candidate[index] as number) * (pair.reference[index] as number);
  return dot / (left * right);
}

/**
 * 処理名: modality集計
 * 処理概要: cosine配列から件数・平均・最小・合否を作る。
 * 実装理由: text/imageを別閾値で判定するため。
 * @param values - cosine配列。
 * @param threshold - 閾値。
 * @returns 集計結果。
 */
function summarize(values: number[], threshold: EmbeddingThresholdLimit): EmbeddingQualityStat {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const minimum = Math.min(...values);
  return { count: values.length, mean, minimum, passed: mean >= threshold.mean && minimum >= threshold.each };
}

/**
 * 処理名: 埋め込み品質評価
 * 処理概要: text/image両方のcosineを独立に集計し閾値判定する。
 * 実装理由: G03品質gateの集計契約を固定するため。
 * @param pairs - 比較対象。
 * @param thresholds - 閾値。
 * @returns 品質report。
 */
export function evaluateEmbeddingQuality(pairs: readonly EmbeddingQualityPair[], thresholds: EmbeddingQualityThresholds): EmbeddingQualityReport {
  const ids = new Set<string>();
  const text: number[] = [];
  const image: number[] = [];
  for (const pair of pairs) {
    if (pair.id.length === 0 || ids.has(pair.id)) throw new VectorError("E_INPUT");
    ids.add(pair.id);
  }
  if (!pairs.some((pair) => pair.modality === "text") || !pairs.some((pair) => pair.modality === "image")) throw new VectorError("E_INPUT");
  for (const pair of pairs) (pair.modality === "text" ? text : image).push(cosine(pair));
  const textStat = summarize(text, thresholds.text);
  const imageStat = summarize(image, thresholds.image);
  return { passed: textStat.passed && imageStat.passed, text: textStat, image: imageStat };
}
