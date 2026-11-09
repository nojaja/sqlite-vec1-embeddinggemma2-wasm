import { VectorError } from "../errors";
import type { EmbeddingCacheIdentity } from "../inference/statement-embedding-cache";

/**
 * 処理名: 公式メタデータレコード構造定義
 * 処理概要: データベースメタデータテーブル(_svw_meta)に格納されるモデル整合性情報を定義する。
 * 実装理由: バインドされたモデルのバージョンや次元数の整合性を追跡するため。
 */
export interface OfficialMetadataRecord {
  productVersion: string;
  modelId: string;
  revision: string;
  fingerprint: string;
  profile: string;
  dimension: number;
  dtype: string;
}

/**
 * 処理名: 公式メタデータレコード生成
 * 処理概要: キャッシュ識別子から製品およびモデル情報のメタデータオブジェクトを構築する。
 * 実装理由: メタデータテーブルへの初期レコード挿入データを生成するため。
 * @param identity - 埋め込みモデル識別情報。
 * @returns 構築された公式メタデータレコード。
 */
export function officialMetadataRecord(identity: EmbeddingCacheIdentity): OfficialMetadataRecord {
  return {
    productVersion: "0.0.3",
    modelId: identity.modelId,
    revision: identity.revision,
    fingerprint: identity.fingerprint,
    profile: identity.profile,
    dimension: 768,
    dtype: "q4"
  };
}

/**
 * 処理名: 公式メタデータ照合検証
 * 処理概要: 保存されたメタデータレコードが現在のモデル識別情報と完全に一致するか検証する。
 * 実装理由: 異なるモデルで作成されたDBへの誤接続を検出し例外とするため。
 * @param actual - DBから読み出されたメタデータオブジェクト。
 * @param identity - 現在バインドされているモデル識別情報。
 */
export function validateOfficialMetadata(
  actual: unknown,
  identity: EmbeddingCacheIdentity
): void {
  if (typeof actual !== "object" || actual === null) {
    throw new VectorError("E_MODEL_MISMATCH");
  }
  const keys = Object.keys(actual);
  if (keys.length !== 7) {
    throw new VectorError("E_MODEL_MISMATCH");
  }
  const record = actual as Record<string, unknown>;
  const match = record.productVersion === "0.0.3"
    && record.modelId === identity.modelId
    && record.revision === identity.revision
    && record.fingerprint === identity.fingerprint
    && record.profile === identity.profile
    && record.dimension === 768
    && record.dtype === "q4";

  if (!match) {
    throw new VectorError("E_MODEL_MISMATCH");
  }
}
