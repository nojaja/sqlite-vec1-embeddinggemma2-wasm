import { VectorError } from "../errors";

/**
 * 処理名: 論理path分割
 * 処理概要: slash区切りの安全なsegmentだけを受理し配列で返す。
 * 実装理由: cache root外のhandle/pathを解決させないため。
 * @param path - 論理path。
 * @returns 検証済みsegment。
 */
export function splitLogicalPath(path: string): string[] {
  if (typeof path !== "string" || path.length === 0) throw new VectorError("E_ASSET_INTEGRITY");
  const segments = path.split("/");
  for (const segment of segments) {
    if (!/^[A-Za-z0-9._-]+$/.test(segment) || segment === "." || segment === "..") throw new VectorError("E_ASSET_INTEGRITY");
  }
  return segments;
}

/**
 * 処理名: 正のsafe integer検証
 * 処理概要: 指定時のoptionが正のsafe integerかを確認する。
 * 実装理由: 不正なchunk/lock設定を既定へ黙って置換しないため。
 * @param value - option値。
 * @param fallback - 未指定時の既定。
 * @returns 検証済み値。
 */
export function positiveOption(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new VectorError("E_INPUT");
  return value;
}
