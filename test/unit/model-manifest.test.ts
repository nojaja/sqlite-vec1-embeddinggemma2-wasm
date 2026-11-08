import { MODEL_ASSET_FILES, validateModelAssets, type ModelAssetDigest } from "../../src/runtime-assets/model-contract";
import { validateModelLicenseEvidence, type ModelLicenseEvidence } from "../../tooling/assets/model-lock";

/**
 * 処理名: 検証用資材digest作成
 * 処理概要: 許可集合に対応する決定的なdigest記録を用意する。
 * 実装理由: 実重みや外部通信なしでmanifest契約を検証するため。
 * @returns 必須資材のdigest記録。
 */
function makeAssetDigests(): ModelAssetDigest[] {
  const result: ModelAssetDigest[] = [];
  for (const asset of MODEL_ASSET_FILES) result.push({ path: asset.path, bytes: 128, sha256: "a".repeat(64) });
  return result;
}

/**
 * 処理名: 完全な資材集合の検証
 * 処理概要: 必須11件とgraph/external dataの対応を確認する。
 * 実装理由: audioや別量子化を暗黙に採用しないため。
 */
function verifyCompleteAssetSet(): void {
  expect(MODEL_ASSET_FILES).toHaveLength(11);
  validateModelAssets(makeAssetDigests());
  expect(MODEL_ASSET_FILES).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: "onnx/model_q4.onnx", source: "model_q4.onnx" }),
    expect.objectContaining({ path: "onnx/model_q4.onnx_data", source: "model_q4.onnx_data" }),
    expect.objectContaining({ path: "onnx/vision_encoder_q4.onnx", source: "vision_encoder_q4.onnx" }),
    expect.objectContaining({ path: "onnx/vision_encoder_q4.onnx_data", source: "vision_encoder_q4.onnx_data" })
  ]));
}

/**
 * 処理名: 欠損と重複の検証
 * 処理概要: 同数でも重複により欠けた資材がある集合を拒否する。
 * 実装理由: 件数だけのREADY判定を防ぐため。
 */
function verifyIncompleteAssets(): void {
  const assets = makeAssetDigests();
  expect(validateModelAssets.bind(undefined, assets.slice(1))).toThrow("E_ASSET_INTEGRITY");
  assets[0] = { ...assets[1] } as ModelAssetDigest;
  expect(validateModelAssets.bind(undefined, assets)).toThrow("E_ASSET_INTEGRITY");
}

/**
 * 処理名: 不正digest検証
 * 処理概要: path traversal、未知資材、sizeとhashの不正を拒否する。
 * 実装理由: manifestを任意ファイル取得や未検証資材の入口にしないため。
 * @param replacement - 不正な資材記録。
 */
function verifyInvalidDigest(replacement: ModelAssetDigest): void {
  const assets = makeAssetDigests();
  assets[0] = replacement;
  expect(validateModelAssets.bind(undefined, assets)).toThrow("E_ASSET_INTEGRITY");
}

test("G00: exact 11-asset model allowlist", verifyCompleteAssetSet);
test("G00: missing or duplicate assets are rejected", verifyIncompleteAssets);
test.each<ModelAssetDigest>([
  { path: "../config.json", bytes: 1, sha256: "a".repeat(64) },
  { path: "/config.json", bytes: 1, sha256: "a".repeat(64) },
  { path: "onnx/audio_encoder_q4.onnx", bytes: 1, sha256: "a".repeat(64) },
  { path: "onnx/model_q4.onnx", bytes: 0, sha256: "a".repeat(64) },
  { path: "onnx/model_q4.onnx", bytes: -1, sha256: "a".repeat(64) },
  { path: "onnx/model_q4.onnx", bytes: Number.NaN, sha256: "a".repeat(64) },
  { path: "onnx/model_q4.onnx", bytes: 1.5, sha256: "a".repeat(64) },
  { path: "onnx/model_q4.onnx", bytes: Number.MAX_SAFE_INTEGER + 1, sha256: "a".repeat(64) },
  { path: "onnx/model_q4.onnx", bytes: 1, sha256: "a".repeat(63) },
  { path: "onnx/model_q4.onnx", bytes: 1, sha256: "A".repeat(64) },
  { path: "onnx/model_q4.onnx", bytes: 1, sha256: "z".repeat(64) }
])("G00: invalid asset record %#", verifyInvalidDigest);

/**
 * 処理名: モデルlicense証跡検証
 * 処理概要: 固定revisionのmetadataとlicense本文hashを持つ証跡だけを受理する。
 * 実装理由: 資材へ一律設定したSPDX名を配布条件の根拠にしないため。
 */
function verifyModelLicenseEvidence(): void {
  const evidence: ModelLicenseEvidence = {
    id: "gemma",
    metadataPath: "README.md",
    metadataBytes: 64,
    metadataSha256: "b".repeat(64),
    textPath: "LICENSE",
    textBytes: 128,
    textSha256: "a".repeat(64)
  };
  expect(validateModelLicenseEvidence(evidence)).toBeUndefined();
  expect(validateModelLicenseEvidence.bind(undefined, { ...evidence, id: "" })).toThrow("E_ASSET_INTEGRITY");
  expect(validateModelLicenseEvidence.bind(undefined, { ...evidence, textSha256: "" })).toThrow("E_ASSET_INTEGRITY");
  expect(validateModelLicenseEvidence.bind(undefined, { ...evidence, textPath: "../LICENSE" })).toThrow("E_ASSET_INTEGRITY");
}

test("G00: model license requires fixed metadata and text evidence", verifyModelLicenseEvidence);