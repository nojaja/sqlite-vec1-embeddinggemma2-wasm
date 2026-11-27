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
 * 処理名: モデル資材検証オプション型
 * 処理概要: 資材検証時の厳格ホワイトリストモードを制御する。
 */
export interface ValidateModelAssetsOptions {
  strictAllowlist?: boolean;
}

/**
 * 処理名: モデルマニフェストプロファイル型
 * 処理概要: マニフェスト内のモデル仕様（次元数・量子化・画像対応等）を保持する。
 */
export interface ModelManifestProfile {
  dimension: number;
  dtype: string;
  vision?: boolean;
  audio?: boolean;
  prefix?: {
    query?: string;
    document?: string;
  };
  maxTokens?: number;
}

/**
 * 処理名: 汎用モデルマニフェスト型
 * 処理概要: モデル識別情報・整合性ハッシュ・プロファイル・資材一覧を保持する。
 */
export interface ModelManifest {
  schemaVersion: number;
  modelId: string;
  repository: string;
  revision: string;
  artifactSetHash: string;
  fingerprint: string;
  profile?: ModelManifestProfile;
  assets: readonly ModelAssetDigest[];
}

/**
 * 処理名: 相対アセットパス安全性検証
 * 処理概要: トラバーサル・絶対パス・バックスラッシュを含まない有効な論理パスであることを検証する。
 * @param path - 検証対象パス。
 * @returns 安全なパスの場合 true。
 */
function isSafeAssetPath(path: unknown): path is string {
  if (typeof path !== "string" || path.length === 0) {
    return false;
  }
  if (path.startsWith("/") || path.includes("\\") || path.includes("..")) {
    return false;
  }
  return !path.includes("%2e") && !path.includes("%2E");
}

/**
 * 処理名: 単一資材ダイジェスト検証
 * 処理概要: 1件の資材レコードについてパス・サイズ・SHA-256 を検証する。
 * @param asset - 資材レコード。
 * @param strictAllowlist - EmbeddingGemma 参照11資材への限定有無。
 * @param seenPaths - 重複検知用セット。
 */
function assertSingleAssetValid(
  asset: ModelAssetDigest,
  strictAllowlist: boolean,
  seenPaths: Set<string>
): void {
  if (!asset || !isSafeAssetPath(asset.path)) {
    throw new VectorError("E_ASSET_INTEGRITY");
  }
  if (strictAllowlist && !ALLOWED_PATH_SET.has(asset.path)) {
    throw new VectorError("E_ASSET_INTEGRITY");
  }
  if (seenPaths.has(asset.path)) {
    throw new VectorError("E_ASSET_INTEGRITY");
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

/**
 * 処理名: モデル資材完全性検証
 * 処理概要: 資材配列のパス・サイズ・SHA-256 に欠損・重複・不正がないことを検証する。
 * 実装理由: 不正または破損したモデルファイルによる推論異常を未然に遮断するため。
 * @param assets - 検証対象の資材ダイジェスト配列。
 * @param options - 検証オプション（既定は参照11資材厳格チェック）。
 */
export function validateModelAssets(
  assets: readonly ModelAssetDigest[],
  options?: ValidateModelAssetsOptions
): void {
  const strict = options?.strictAllowlist ?? true;
  if (!Array.isArray(assets) || assets.length === 0) {
    throw new VectorError("E_ASSET_INTEGRITY");
  }
  if (strict && assets.length !== 11) {
    throw new VectorError("E_ASSET_INTEGRITY");
  }

  const seenPaths = new Set<string>();
  for (const asset of assets) {
    assertSingleAssetValid(asset, strict, seenPaths);
  }

  if (strict && seenPaths.size !== 11) {
    throw new VectorError("E_ASSET_INTEGRITY");
  }
}

/**
 * 処理名: 汎用モデルマニフェスト検証
 * 処理概要: マニフェスト JSON のスキーマ構造、必須フィールド、プロファイル次元、および資材配列の整合性を検証する。
 * 実装理由: 固定モデル比較を撤廃し、ruri-v3 等の任意モデルマニフェストを安全に受理するため。
 * @param manifest - 検証対象のマニフェストオブジェクト。
 * @param allowEmptyAssets - 単体テスト境界向けに空アセット配列を許容するか。
 */
export function validateModelManifest(manifest: unknown, allowEmptyAssets = false): void {
  if (!manifest || typeof manifest !== "object") {
    throw new VectorError("E_ASSET_INTEGRITY");
  }
  const m = manifest as Partial<ModelManifest>;
  if (
    (m.schemaVersion !== undefined && m.schemaVersion !== 1) ||
    typeof m.modelId !== "string" ||
    m.modelId.trim().length === 0 ||
    typeof m.repository !== "string" ||
    m.repository.trim().length === 0 ||
    typeof m.revision !== "string" ||
    m.revision.trim().length === 0 ||
    typeof m.artifactSetHash !== "string" ||
    !SHA256_REGEX.test(m.artifactSetHash) ||
    typeof m.fingerprint !== "string" ||
    !SHA256_REGEX.test(m.fingerprint) ||
    !Array.isArray(m.assets)
  ) {
    throw new VectorError("E_ASSET_INTEGRITY");
  }

  if (m.profile !== undefined) {
    if (
      typeof m.profile !== "object" ||
      !Number.isSafeInteger(m.profile.dimension) ||
      m.profile.dimension <= 0 ||
      m.profile.dimension > 2040 ||
      typeof m.profile.dtype !== "string" ||
      m.profile.dtype.trim().length === 0
    ) {
      throw new VectorError("E_ASSET_INTEGRITY");
    }
  }

  if (m.assets.length > 0 || !allowEmptyAssets) {
    const strict = m.modelId === MODEL_ID;
    validateModelAssets(m.assets, { strictAllowlist: strict });
  }
}
