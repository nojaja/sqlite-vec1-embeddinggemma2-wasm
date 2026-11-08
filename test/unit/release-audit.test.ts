import { validateReleaseAudit, type ReleaseAuditSummary } from "../../tooling/release/release-audit";

/**
 * 処理名: 正常監査結果検証
 * 処理概要: 全severityが0のnpm audit要約を受理する。
 * 実装理由: G00の既知脆弱性なし条件を明示するため。
 */
function verifyCleanAudit(): void {
  const summary: ReleaseAuditSummary = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 };
  expect(validateReleaseAudit(summary)).toBeUndefined();
}

/**
 * 処理名: 脆弱監査結果検証
 * 処理概要: severity別またはtotalに脆弱性がある結果を拒否する。
 * 実装理由: audit commandの終了codeだけに依存した誤合格を防ぐため。
 * @param summary - 不合格にする監査要約。
 */
function verifyRejectedAudit(summary: ReleaseAuditSummary): void {
  expect(validateReleaseAudit.bind(undefined, summary)).toThrow("E_ASSET_INTEGRITY");
}

test("G00: clean release audit is accepted", verifyCleanAudit);
test.each<ReleaseAuditSummary>([
  { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 },
  { info: 0, low: 1, moderate: 0, high: 0, critical: 0, total: 1 },
  { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 1 },
  { info: 0, low: 0, moderate: 0, high: -1, critical: 0, total: 0 }
])("G00: vulnerable or malformed release audit is rejected %#", verifyRejectedAudit);