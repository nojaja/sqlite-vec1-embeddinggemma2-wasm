import { VectorError } from "../errors";

/**
 * 処理名: 公開モデルID定数
 * 処理概要: パッケージが公開するモデル名文字列を定義する。
 * 実装理由: モデル識別名を一意に管理するため。
 */
export const MODEL_ID = "embeddinggemma-2";

/**
 * 処理名: 元モデルID定数
 * 処理概要: 上流のオリジナルモデル識別文字列を定義する。
 * 実装理由: 元モデルリポジトリの出所を明示するため。
 */
export const ORIGINAL_MODEL_ID = "google/embeddinggemma-2";

/**
 * 処理名: ONNXリポジトリ定数
 * 処理概要: Hugging Face上のONNXモデルリポジトリパスを定義する。
 * 実装理由: リモート資材取得元を一意に特定するため。
 */
export const MODEL_REPOSITORY = "onnx-community/embeddinggemma-2-ONNX";

/**
 * 処理名: 固定リビジョン定数
 * 処理概要: 固定コミットハッシュリビジョン文字列を定義する。
 * 実装理由: モデル資材の改ざんや更新による不整合を防止するため。
 */
export const MODEL_REVISION = "daa72c51243991dfcaf9f9137d2c573d8f7790c0";

/**
 * 処理名: モデル資材定義インターフェース
 * 処理概要: 各モデル資材のパス、ソース、役割、MIMEタイプ、ライセンスを定義する。
 * 実装理由: モデル構成アセットのメタデータを構造化するため。
 */
export interface ModelAssetDefinition { path: string; source: string; role: string; mime: string; license: "apache-2.0" }

/**
 * 処理名: モデル資材ダイジェストインターフェース
 * 処理概要: 資材の論理パス、バイトサイズ、SHA-256ハッシュを定義する。
 * 実装理由: 資材の整合性検証に必要な情報を保持するため。
 */
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

/**
 * 処理名: 必須モデル資材一覧定数
 * 処理概要: モデル推論に必要な固定順序の11個の資材定義配列を定義する。
 * 実装理由: 完全な資材集合の検証と配置を保証するため。
 */
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

/**
 * 処理名: モデルマニフェストインターフェース
 * 処理概要: モデルメタデータおよび全資材ダイジェストを含むマニフェスト構造を定義する。
 * 実装理由: マニフェスト全体の完全性検証を型安全に行うため。
 */
export interface ModelManifest {
  modelId: string;
  repository: string;
  revision: string;
  artifactSetHash: string;
  fingerprint: string;
  assets: ModelAssetDigest[];
}
