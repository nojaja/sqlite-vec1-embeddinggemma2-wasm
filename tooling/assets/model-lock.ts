import { VectorError } from "../../src/errors";

/**
 * 処理名: モデルライセンス証跡型
 * 処理概要: モデル配布条件の根拠となる SPDX 相当 ID、README および LICENSE ファイルのダイジェストを保持する。
 * 実装理由: モデル利用ライセンスの正当性を機械的に検証可能にするため。
 */
export interface ModelLicenseEvidence {
  id: string;
  metadataPath: string;
  metadataBytes: number;
  metadataSha256: string;
  textPath: string;
  textBytes: number;
  textSha256: string;
}

const SHA256_REGEX = /^[0-9a-f]{64}$/;

/**
 * 処理名: モデルライセンス証跡検証
 * 処理概要: ライセンス識別子、固定ファイルパス、バイトサイズ、SHA-256 ダイジェストを検証する。
 * 実装理由: 不正なライセンス置換や改ざんされたモデル証跡の混入を防止するため。
 * @param evidence - 検証対象のライセンス証跡オブジェクト。
 */
export function validateModelLicenseEvidence(evidence: ModelLicenseEvidence): void {
  if (!evidence || typeof evidence.id !== "string" || evidence.id.trim().length === 0) {
    throw new VectorError("E_ASSET_INTEGRITY");
  }

  if (evidence.metadataPath !== "README.md" || evidence.textPath !== "LICENSE") {
    throw new VectorError("E_ASSET_INTEGRITY");
  }

  if (
    typeof evidence.metadataBytes !== "number" ||
    !Number.isSafeInteger(evidence.metadataBytes) ||
    evidence.metadataBytes <= 0
  ) {
    throw new VectorError("E_ASSET_INTEGRITY");
  }

  if (
    typeof evidence.textBytes !== "number" ||
    !Number.isSafeInteger(evidence.textBytes) ||
    evidence.textBytes <= 0
  ) {
    throw new VectorError("E_ASSET_INTEGRITY");
  }

  if (
    typeof evidence.metadataSha256 !== "string" ||
    !SHA256_REGEX.test(evidence.metadataSha256) ||
    typeof evidence.textSha256 !== "string" ||
    !SHA256_REGEX.test(evidence.textSha256)
  ) {
    throw new VectorError("E_ASSET_INTEGRITY");
  }
}
