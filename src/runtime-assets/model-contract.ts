import { VectorError } from "../errors";

/**
 * 処理名: 参照モデル識別子定数
 * 処理概要: Google 公式 EmbeddingGemma 2 モデル ID を定義する。
 * 実装理由: モデル仕様およびマニフェスト整合性検証のため。
 */
export const MODEL_ID = "google/embeddinggemma-2";

/**
 * 処理名: ONNX リポジトリ定数
 * 処理概要: Hugging Face 上の固定 ONNX コミュニティリポジトリ名を定義する。
 * 実装理由: 正準なダウンロード出元を固定するため。
 */
export const MODEL_REPOSITORY = "onnx-community/embeddinggemma-2-ONNX";

/**
 * 処理名: 固定リビジョン定数
 * 処理概要: 完全性が保証されたコミットハッシュリビジョンを定義する。
 * 実装理由: 不変なモデル成果物を参照し、予期せぬ更新を防ぐため。
 */
export const MODEL_REVISION = "daa72c51243991dfcaf9f9137d2c573d8f7790c0";

/**
 * 処理名: モデル資材定義型
 * 処理概要: マニフェスト論理パス、ソースファイル名、および MIME タイプを保持する型。
 * 実装理由: 内部キャッシュキーと外部取得ファイル名の対応付けおよび HTTP 配信 MIME 設定のため。
 */
export interface ModelAssetFileDefinition {
  path: string;
  source: string;
  mime: string;
}

/**
 * 処理名: モデル資材ダイジェスト型
 * 処理概要: マニフェスト論理パス、バイト長、SHA-256 ダイジェストを保持する型。
 * 実装理由: キャッシュ保存時の静的・動的完全性検証のため。
 */
export interface ModelAssetDigest {
  path: string;
  bytes: number;
  sha256: string;
}

/**
 * 処理名: 必須 11 モデル資材定義配列
 * 処理概要: EmbeddingGemma 2 q4 推論に必要な全 11 資材の論理パス、ソース名、および MIME タイプを定義する。
 * 実装理由: 不要なエンコーダーや別量子化を排除し、厳格なアセットホワイトリストを形成するため。
 */
export const MODEL_ASSET_FILES: readonly ModelAssetFileDefinition[] = [
  { path: "onnx/model_q4.onnx", source: "model_q4.onnx", mime: "application/octet-stream" },
  { path: "onnx/model_q4.onnx_data", source: "model_q4.onnx_data", mime: "application/octet-stream" },
  { path: "onnx/vision_encoder_q4.onnx", source: "vision_encoder_q4.onnx", mime: "application/octet-stream" },
  { path: "onnx/vision_encoder_q4.onnx_data", source: "vision_encoder_q4.onnx_data", mime: "application/octet-stream" },
  { path: "config.json", source: "config.json", mime: "application/json" },
  { path: "processor_config.json", source: "processor_config.json", mime: "application/json" },
  { path: "preprocessor_config.json", source: "preprocessor_config.json", mime: "application/json" },
  { path: "tokenizer.json", source: "tokenizer.json", mime: "application/json" },
  { path: "tokenizer_config.json", source: "tokenizer_config.json", mime: "application/json" },
  { path: "config_sentence_transformers.json", source: "config_sentence_transformers.json", mime: "application/json" },
  { path: "chat_template.jinja", source: "chat_template.jinja", mime: "text/plain" }
];

const ALLOWED_PATH_SET = new Set(MODEL_ASSET_FILES.map((a) => a.path));
const SHA256_REGEX = /^[0-9a-f]{64}$/;

/**
 * 処理名: モデル資材完全性検証
 * 処理概要: 資材配列が厳格に 11 件であり、パス・サイズ・SHA-256 に欠損・重複・不正がないことを検証する。
 * 実装理由: 不正または破損したモデルファイルによる推論異常を未然に遮断するため。
 * @param assets - 検証対象の資材ダイジェスト配列。
 */
export function validateModelAssets(assets: readonly ModelAssetDigest[]): void {
  if (!Array.isArray(assets) || assets.length !== 11) {
    throw new VectorError("E_ASSET_INTEGRITY");
  }

  const seenPaths = new Set<string>();
  for (const asset of assets) {
    if (!asset || typeof asset.path !== "string" || !ALLOWED_PATH_SET.has(asset.path)) {
      throw new VectorError("E_ASSET_INTEGRITY");
    }
    if (seenPaths.has(asset.path)) {
      throw new VectorError("E_ASSET_INTEGRITY"); // 重複拒絶
    }
    seenPaths.add(asset.path);

    if (
      typeof asset.bytes !== "number" ||
      !Number.isSafeInteger(asset.bytes) ||
      asset.bytes <= 0 ||
      asset.bytes > Number.MAX_SAFE_INTEGER
    ) {
      throw new VectorError("E_ASSET_INTEGRITY");
    }

    if (typeof asset.sha256 !== "string" || !SHA256_REGEX.test(asset.sha256)) {
      throw new VectorError("E_ASSET_INTEGRITY");
    }
  }

  if (seenPaths.size !== 11) {
    throw new VectorError("E_ASSET_INTEGRITY");
  }
}
