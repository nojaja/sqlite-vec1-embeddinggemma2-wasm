const FLOAT_BYTES = 4;

/**
 * 処理名: flat検索候補
 * 処理概要: rowidと独立計算したcosine距離を保持する。
 * 実装理由: vec1結果とJavaScript全数計算を同じ形で比較するため。
 */
export interface FlatCandidate {
  /** 処理名: 行識別子。処理概要: SQLite rowidを保持する。実装理由: 同距離時の順序を固定するため。 */
  rowid: bigint;
  /** 処理名: cosine距離。処理概要: 独立計算値を保持する。実装理由: vec1距離を再利用せず検証するため。 */
  distance: number;
}

/**
 * 処理名: embedding復号
 * 処理概要: little-endian Float32 BLOBを独立した数値配列へ変換する。
 * 実装理由: vec1の距離値を使わず同じ永続vectorを全数計算するため。
 * @param blob - SQLiteからcopyされたembedding BLOB。
 * @returns 復号済みFloat32 vector。
 */
export function decodeFloat32LittleEndian(blob: Uint8Array): Float32Array {
  if (blob.byteLength === 0 || blob.byteLength % FLOAT_BYTES !== 0) throw new Error("INVALID_VECTOR_BYTES");
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const result = new Float32Array(blob.byteLength / FLOAT_BYTES);
  for (let index = 0; index < result.length; index += 1) {
    const value = view.getFloat32(index * FLOAT_BYTES, true);
    if (!Number.isFinite(value)) throw new Error("INVALID_VECTOR_VALUE");
    result[index] = value;
  }
  return result;
}

/**
 * 処理名: cosine距離独立計算
 * 処理概要: 二vectorのdot積とnormを倍精度で全要素集計する。
 * 実装理由: SQLite/vec1実装から独立した期待値を作るため。
 * @param left - 第一vector。
 * @param right - 第二vector。
 * @returns 1からcosine similarityを引いた距離。
 */
export function cosineDistance(left: Float32Array, right: Float32Array): number {
  if (left.length === 0 || left.length !== right.length) throw new Error("VECTOR_DIMENSION_MISMATCH");
  let dot = 0;
  let leftSquared = 0;
  let rightSquared = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index];
    const rightValue = right[index];
    if (leftValue === undefined || rightValue === undefined || !Number.isFinite(leftValue) || !Number.isFinite(rightValue)) throw new Error("INVALID_VECTOR_VALUE");
    dot += leftValue * rightValue;
    leftSquared += leftValue * leftValue;
    rightSquared += rightValue * rightValue;
  }
  if (leftSquared === 0 || rightSquared === 0) throw new Error("ZERO_VECTOR");
  return 1 - dot / Math.sqrt(leftSquared * rightSquared);
}

/**
 * 処理名: flat全数順位計算
 * 処理概要: 全rowのcosine距離を計算し距離、rowid順に並べる。
 * 実装理由: ANNやvec1検索結果を期待値生成へ使用しないため。
 * @param vectors - rowidとvectorの組。
 * @param query - query vector。
 * @returns 独立計算した全候補順位。
 */
export function rankFlat(vectors: ReadonlyMap<bigint, Float32Array>, query: Float32Array): FlatCandidate[] {
  return [...vectors].map(([rowid, vector]) => ({ rowid, distance: cosineDistance(vector, query) }))
    .sort((left, right) => left.distance - right.distance || (left.rowid < right.rowid ? -1 : left.rowid > right.rowid ? 1 : 0));
}
