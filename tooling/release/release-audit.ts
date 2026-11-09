import { VectorError } from "../../src/errors";

/**
 * 処理名: リリース監査サマリー定義
 * 処理概要: npm audit の脆弱性深刻度別カウントを定義する。
 * 実装理由: リリース資材のセキュリティ監査基準を厳密に照合するため。
 */
export interface ReleaseAuditSummary {
  info: number;
  low: number;
  moderate: number;
  high: number;
  critical: number;
  total: number;
}

/**
 * 処理名: リリース監査結果検証
 * 処理概要: 監査サマリー値の妥当性および脆弱性ゼロを確認する。
 * 実装理由: 既知の脆弱性が混入したリリースを未然に防止するため。
 * @param summary - 監査サマリーオブジェクト。
 */
export function validateReleaseAudit(summary: ReleaseAuditSummary): void {
  const fields = ["info", "low", "moderate", "high", "critical", "total"] as const;
  for (const field of fields) {
    const val = summary[field];
    if (!Number.isSafeInteger(val) || val < 0) {
      throw new VectorError("E_ASSET_INTEGRITY");
    }
  }
  const sum = summary.info + summary.low + summary.moderate + summary.high + summary.critical;
  if (summary.total !== sum || summary.total !== 0) {
    throw new VectorError("E_ASSET_INTEGRITY");
  }
}
