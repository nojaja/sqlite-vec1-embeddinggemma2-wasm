import { VectorError } from "../errors";
import type { EmbeddingCacheIdentity } from "../inference/statement-embedding-cache";

export interface OfficialMetadataRecord {
  productVersion: string;
  modelId: string;
  revision: string;
  fingerprint: string;
  profile: string;
  dimension: number;
  dtype: string;
}

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
