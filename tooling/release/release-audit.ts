import { VectorError } from "../../src/errors";

/**
 * 処理名: リリース監査サマリーインターフェース
 * 処理概要: npm audit の各深刻度別件数および合計件数を保持する。
 * 実装理由: G00 監査基準に基づき、サプライチェーンの脆弱性フリーを検証するため。
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
 * 処理名: リリース監査結果検証関数
 * 処理概要: 監査結果の全件数が非負整数かつ合計が一致し、全深刻度で件数が 0 であることを検証する。
 * 実装理由: 既知脆弱性の混入および malformed な監査出力を確実に遮断するため。
 * @param summary - 検証対象の監査要約。
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
  if (sum !== summary.total) {
    throw new VectorError("E_ASSET_INTEGRITY");
  }

  if (summary.total !== 0) {
    throw new VectorError("E_ASSET_INTEGRITY");
  }
}
