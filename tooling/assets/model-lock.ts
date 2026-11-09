import { VectorError } from "../../src/errors";

/**
 * 処理名: モデルlicense証跡定義
 * 処理概要: モデルのライセンスおよび証跡メタデータの構造を定義する。
 * 実装理由: 配布条件の根拠を固定metadataと本文hashへ結び付けるため。
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

/**
 * 処理名: license証跡検証
 * 処理概要: id・固定path・正size・小文字64桁hashを確認する。
 * 実装理由: 配布条件の根拠を固定metadataと本文hashへ結び付けるため。
 * @param evidence - 証跡。
 */
export function validateModelLicenseEvidence(evidence: ModelLicenseEvidence): void {
  const hash = /^[0-9a-f]{64}$/;
  const valid = /^[a-z0-9][a-z0-9.+-]*$/.test(evidence.id)
    && evidence.metadataPath === "README.md" && evidence.textPath === "LICENSE"
    && Number.isSafeInteger(evidence.metadataBytes) && evidence.metadataBytes > 0
    && Number.isSafeInteger(evidence.textBytes) && evidence.textBytes > 0
    && hash.test(evidence.metadataSha256) && hash.test(evidence.textSha256);
  if (!valid) throw new VectorError("E_ASSET_INTEGRITY");
}
