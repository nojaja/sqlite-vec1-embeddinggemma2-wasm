import { VectorError } from "../errors";

/** 公開model名。 */
export const MODEL_ID = "embeddinggemma-2";
/** 元model ID。 */
export const ORIGINAL_MODEL_ID = "google/embeddinggemma-2";
/** ONNX repository。 */
export const MODEL_REPOSITORY = "onnx-community/embeddinggemma-2-ONNX";
/** 固定revision。 */
export const MODEL_REVISION = "daa72c51243991dfcaf9f9137d2c573d8f7790c0";

/** 資材定義。 */
export interface ModelAssetDefinition { path: string; source: string; role: string; mime: string; license: "apache-2.0" }
/** 資材digest。 */
export interface ModelAssetDigest { path: string; bytes: number; sha256: string }

const OCTET = "application/octet-stream";
const JSON_MIME = "application/json";

/**
 * 処理名: 資材定義作成
 * 処理概要: path・role・mimeから固定定義を作る。
 * 実装理由: 11資材の記述を簡潔にするため。
 * @param path - manifest論理path。
 * @param role - 資材役割。
 * @param mime - MIME。
 * @param flat - graph/dataのようにbasenameをsourceとするか。
 * @returns 資材定義。
 */
function define(path: string, role: string, mime: string, flat = false): ModelAssetDefinition {
  return { path, source: flat ? path.slice(path.lastIndexOf("/") + 1) : path, role, mime, license: "apache-2.0" };
}

/** 必須11資材(固定順)。 */
export const MODEL_ASSET_FILES: readonly ModelAssetDefinition[] = Object.freeze([
  define("onnx/model_q4.onnx", "text-graph", OCTET, true),
  define("onnx/model_q4.onnx_data", "text-weights", OCTET, true),
  define("onnx/vision_encoder_q4.onnx", "vision-graph", OCTET, true),
  define("onnx/vision_encoder_q4.onnx_data", "vision-weights", OCTET, true),
  define("config.json", "model-config", JSON_MIME),
  define("processor_config.json", "processor", JSON_MIME),
  define("preprocessor_config.json", "image-processor", JSON_MIME),
  define("tokenizer.json", "tokenizer", JSON_MIME),
  define("tokenizer_config.json", "tokenizer-config", JSON_MIME),
  define("config_sentence_transformers.json", "sentence-config", JSON_MIME),
  define("chat_template.jinja", "template", "text/plain")
]);

/**
 * 処理名: 資材集合検証
 * 処理概要: 必須11資材の完全集合とbytes/sha256形式を確認する。
 * 実装理由: 欠落・重複・未知資材を未検証のまま受理しないため。
 * @param assets - 検証対象digest。
 */
export function validateModelAssets(assets: readonly ModelAssetDigest[]): void {
  if (!Array.isArray(assets) || assets.length !== MODEL_ASSET_FILES.length) throw new VectorError("E_ASSET_INTEGRITY");
  const allowed = new Set(MODEL_ASSET_FILES.map((asset) => asset.path));
  const seen = new Set<string>();
  for (const asset of assets) {
    const valid = allowed.has(asset.path) && !seen.has(asset.path)
      && Number.isSafeInteger(asset.bytes) && asset.bytes > 0 && /^[0-9a-f]{64}$/.test(asset.sha256);
    if (!valid) throw new VectorError("E_ASSET_INTEGRITY");
    seen.add(asset.path);
  }
}

/** モデルマニフェスト型。 */
export interface ModelManifest {
  modelId: string;
  repository: string;
  revision: string;
  artifactSetHash: string;
  fingerprint: string;
  assets: ModelAssetDigest[];
}
