import { VectorError } from "../../src/errors";

export interface ReleaseAuditSummary {
  info: number;
  low: number;
  moderate: number;
  high: number;
  critical: number;
  total: number;
}

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
