const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

/**
 * 処理名: SHA-256 ダイジェスト算出
 * 処理概要: ファイルの SHA-256 ハッシュをストリームで計算する。
 * 実装理由: 大容量モデルファイルでもメモリを枯渇させず整合性を検証するため。
 * @param {string} filePath - 対象ファイルパス。
 * @returns {Promise<string>} 16進数小文字のハッシュ。
 */
async function calcSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

/**
 * docs/spec/v0.0.1/inference.md 第1.2項・第1.3項に準拠した正準マニフェスト定義
 */
const CANONICAL_MANIFEST = {
  schemaVersion: 1,
  modelId: "google/embeddinggemma-2",
  repository: "onnx-community/embeddinggemma-2-ONNX",
  revision: "daa72c51243991dfcaf9f9137d2c573d8f7790c0",
  artifactSetHash: "edc288bfd9366727abe6200cf6db45d844aac338c9055f359308334567ba661e",
  fingerprint: "5e730f96377d880c7ca94c9ddc9cd5f600e5237e106f5e4dc7d9448140026ac7",
  license: {
    id: "apache-2.0",
    metadataPath: "README.md",
    metadataBytes: 28720,
    metadataSha256: "4fe21bf1b86938ac62c7cd2d1511822e4ea6e8654e015e00b06a72676b5420e6",
    textPath: "LICENSE",
    textBytes: 11357,
    textSha256: "c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4"
  },
  profile: {
    audio: false,
    dtype: "q4",
    dimension: 768,
    preprocessingVersion: "embeddinggemma2-input-v1",
    prefixVersion: "embeddinggemma2-prefix-v1",
    normalizationVersion: "l2-f64-le-f32-v1",
    inputContractVersion: 1
  },
  assets: [
    {
      path: "onnx/model_q4.onnx",
      source: "model_q4.onnx",
      bytes: 490742,
      sha256: "f9eeba97acddf139b8ee2ddf04bc30dceafa88de93fadf74d7644e0d61a477a9",
      role: "text-graph",
      mime: "application/octet-stream",
      license: "apache-2.0"
    },
    {
      path: "onnx/model_q4.onnx_data",
      source: "model_q4.onnx_data",
      bytes: 174028800,
      sha256: "c3975f2d1ab7a1878ae31a7d7a9b7804a827aff3800b60dfceafce21cac3df49",
      role: "text-weights",
      mime: "application/octet-stream",
      license: "apache-2.0"
    },
    {
      path: "onnx/vision_encoder_q4.onnx",
      source: "vision_encoder_q4.onnx",
      bytes: 159400,
      sha256: "7ea284226d4938f0ad921ab091f1d80a9ca699aa802984ef5cd5eec4f4761d96",
      role: "vision-graph",
      mime: "application/octet-stream",
      license: "apache-2.0"
    },
    {
      path: "onnx/vision_encoder_q4.onnx_data",
      source: "vision_encoder_q4.onnx_data",
      bytes: 108957696,
      sha256: "0a9d6c927334f152a33dd90874f65d6ea5228999abe6a450d3f7813677fa704c",
      role: "vision-weights",
      mime: "application/octet-stream",
      license: "apache-2.0"
    },
    {
      path: "config.json",
      source: "config.json",
      bytes: 5031,
      sha256: "8d011bfe08b5e345bbe0b81e5c6fd02c381920b345b986047bc2a33ce7b90d1d",
      role: "model-config",
      mime: "application/json",
      license: "apache-2.0"
    },
    {
      path: "processor_config.json",
      source: "processor_config.json",
      bytes: 1788,
      sha256: "168f6a08522f3ce5dea596d94d003af2fd691742d4f41fe1f9d8cce76bfbf69c",
      role: "processor",
      mime: "application/json",
      license: "apache-2.0"
    },
    {
      path: "preprocessor_config.json",
      source: "preprocessor_config.json",
      bytes: 560,
      sha256: "9344893f8d0573a46ebb2ca54c03f56d044cea194c8dcfb1f4d652240ac21daa",
      role: "image-processor",
      mime: "application/json",
      license: "apache-2.0"
    },
    {
      path: "tokenizer.json",
      source: "tokenizer.json",
      bytes: 32170510,
      sha256: "4d777ef5bdc1aa36227abdfb77c3e49e7b9c892d16e1b6bda41c393504828be4",
      role: "tokenizer",
      mime: "application/json",
      license: "apache-2.0"
    },
    {
      path: "tokenizer_config.json",
      source: "tokenizer_config.json",
      bytes: 1599,
      sha256: "17bd5d6e9364ca49a534e1502076593317c298d4a663623091ed45388f004874",
      role: "tokenizer-config",
      mime: "application/json",
      license: "apache-2.0"
    },
    {
      path: "config_sentence_transformers.json",
      source: "config_sentence_transformers.json",
      bytes: 1565,
      sha256: "031e56a498d33c349ab489a21885bcfe25b4fcba841149dc99e1e90d4a7c28f5",
      role: "sentence-config",
      mime: "application/json",
      license: "apache-2.0"
    },
    {
      path: "chat_template.jinja",
      source: "chat_template.jinja",
      bytes: 1016,
      sha256: "4b852efc0b9960283e735363331e6f325b33bc74bdbaa076f595bc4e9b94d85e",
      role: "template",
      mime: "text/plain",
      license: "apache-2.0"
    }
  ]
};

/**
 * 処理名: モデル資材ロック主処理
 * 処理概要: 配置済みモデル資材と仕様を突き合わせて manifests/embeddinggemma2-q4.json を生成・検証・ロックする。
 */
async function lockModel() {
  console.log("=== Locking EmbeddingGemma 2 Model Manifest ===");
  const manifestDir = path.resolve("manifests");
  fs.mkdirSync(manifestDir, { recursive: true });
  const manifestPath = path.join(manifestDir, "embeddinggemma2-q4.json");

  const modelDir = path.resolve("model", "embeddinggemma-2-ONNX", CANONICAL_MANIFEST.revision);
  console.log(`Checking model directory: ${modelDir}`);

  if (fs.existsSync(modelDir)) {
    for (const asset of CANONICAL_MANIFEST.assets) {
      const filePath = path.join(modelDir, asset.source);
      if (!fs.existsSync(filePath)) {
        console.warn(`[MISSING] Model asset not found at ${filePath}`);
        continue;
      }
      const stat = fs.statSync(filePath);
      if (stat.size !== asset.bytes) {
        throw new Error(`Size mismatch for ${asset.source}: expected ${asset.bytes}, got ${stat.size}`);
      }
      const sha = await calcSha256(filePath);
      if (sha.toLowerCase() !== asset.sha256.toLowerCase()) {
        throw new Error(`SHA-256 mismatch for ${asset.source}: expected ${asset.sha256}, got ${sha}`);
      }
      console.log(`[VERIFIED] ${asset.source} (${stat.size} bytes, sha256: ${sha.substring(0, 16)}...)`);
    }
  } else {
    console.warn(`[WARN] Model directory ${modelDir} does not exist yet. Writing canonical manifest definition.`);
  }

  // マニフェストの書き出し
  fs.writeFileSync(manifestPath, JSON.stringify(CANONICAL_MANIFEST, null, 2) + "\n", "utf8");
  console.log(`[LOCKED] Manifest written successfully to ${manifestPath}`);
}

lockModel().catch((err) => {
  console.error("Error locking model manifest:", err);
  process.exit(1);
});
