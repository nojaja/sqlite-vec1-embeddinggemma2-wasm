import { validateOfficialMetadata, officialMetadataRecord } from "../../src/official/metadata";

const identity = { modelId: "embeddinggemma-2", revision: "r", fingerprint: "f".repeat(64), profile: "p", backend: "wasm", runtimeGeneration: 1 };

test("official metadata: binds version and embedding space without backend migration", () => {
  const record = officialMetadataRecord(identity);
  expect(record).toMatchObject({ productVersion: "0.0.3", dimension: 768, dtype: "q4", fingerprint: identity.fingerprint, profile: "p" });
  expect(() => validateOfficialMetadata(record, identity)).not.toThrow();
  expect(() => validateOfficialMetadata(record, { ...identity, backend: "directml" })).not.toThrow();
});

test("official metadata: rejects unknown schema or mixed model space", () => {
  const record = officialMetadataRecord(identity);
  expect(() => validateOfficialMetadata({ ...record, productVersion: "0.0.2" }, identity)).toThrow("E_MODEL_MISMATCH");
  expect(() => validateOfficialMetadata({ ...record, fingerprint: "x".repeat(64) }, identity)).toThrow("E_MODEL_MISMATCH");
  expect(() => validateOfficialMetadata({ ...record, profile: "other" }, identity)).toThrow("E_MODEL_MISMATCH");
  expect(() => validateOfficialMetadata({}, identity)).toThrow("E_MODEL_MISMATCH");
});