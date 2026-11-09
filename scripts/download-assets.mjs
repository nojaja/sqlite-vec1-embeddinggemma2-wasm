import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";

const DOWNLOAD_ITEMS = [
  {
    target: "downloads/sqlite-wasm-ccbb81134a3b5a824f8a3cc3c5d8edd6e799ab5a.tar.gz",
    url: "https://codeload.github.com/sqlite/sqlite-wasm/tar.gz/ccbb81134a3b5a824f8a3cc3c5d8edd6e799ab5a"
  }
];

const MODEL_BASE_URL = "https://huggingface.co/onnx-community/embeddinggemma-2-ONNX/resolve/daa72c51243991dfcaf9f9137d2c573d8f7790c0";
const MODEL_DIR = "model/embeddinggemma-2-ONNX/daa72c51243991dfcaf9f9137d2c573d8f7790c0";

const MODEL_ITEMS = [
  { file: "model_q4.onnx", url: `${MODEL_BASE_URL}/onnx/model_q4.onnx`, expectedSha256: "f9eeba97acddf139b8ee2ddf04bc30dceafa88de93fadf74d7644e0d61a477a9", bytes: 490742 },
  { file: "model_q4.onnx_data", url: `${MODEL_BASE_URL}/onnx/model_q4.onnx_data`, expectedSha256: "c3975f2d1ab7a1878ae31a7d7a9b7804a827aff3800b60dfceafce21cac3df49", bytes: 174028800 },
  { file: "vision_encoder_q4.onnx", url: `${MODEL_BASE_URL}/onnx/vision_encoder_q4.onnx`, expectedSha256: "7ea284226d4938f0ad921ab091f1d80a9ca699aa802984ef5cd5eec4f4761d96", bytes: 159400 },
  { file: "vision_encoder_q4.onnx_data", url: `${MODEL_BASE_URL}/onnx/vision_encoder_q4.onnx_data`, expectedSha256: "0a9d6c927334f152a33dd90874f65d6ea5228999abe6a450d3f7813677fa704c", bytes: 108957696 },
  { file: "config.json", url: `${MODEL_BASE_URL}/config.json`, expectedSha256: "8d011bfe08b5e345bbe0b81e5c6fd02c381920b345b986047bc2a33ce7b90d1d", bytes: 5031 },
  { file: "processor_config.json", url: `${MODEL_BASE_URL}/processor_config.json`, expectedSha256: "168f6a08522f3ce5dea596d94d003af2fd691742d4f41fe1f9d8cce76bfbf69c", bytes: 1788 },
  { file: "preprocessor_config.json", url: `${MODEL_BASE_URL}/preprocessor_config.json`, expectedSha256: "9344893f8d0573a46ebb2ca54c03f56d044cea194c8dcfb1f4d652240ac21daa", bytes: 560 },
  { file: "tokenizer.json", url: `${MODEL_BASE_URL}/tokenizer.json`, expectedSha256: "4d777ef5bdc1aa36227abdfb77c3e49e7b9c892d16e1b6bda41c393504828be4", bytes: 32170510 },
  { file: "tokenizer_config.json", url: `${MODEL_BASE_URL}/tokenizer_config.json`, expectedSha256: "17bd5d6e9364ca49a534e1502076593317c298d4a663623091ed45388f004874", bytes: 1599 },
  { file: "config_sentence_transformers.json", url: `${MODEL_BASE_URL}/config_sentence_transformers.json`, expectedSha256: "031e56a498d33c349ab489a21885bcfe25b4fcba841149dc99e1e90d4a7c28f5", bytes: 1565 },
  { file: "chat_template.jinja", url: `${MODEL_BASE_URL}/chat_template.jinja`, expectedSha256: "4b852efc0b9960283e735363331e6f325b33bc74bdbaa076f595bc4e9b94d85e", bytes: 1016 }
];

function calcSha256(filePath) {
  const hash = crypto.createHash("sha256");
  const data = fs.readFileSync(filePath);
  hash.update(data);
  return hash.digest("hex");
}

async function downloadFile(url, destPath) {
  console.log(`Downloading ${url} -> ${destPath}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`Failed to download ${url}: ${res.status} ${res.statusText}`);
  }
  const fileStream = fs.createWriteStream(destPath);
  await finished(Readable.fromWeb(res.body).pipe(fileStream));
}

async function ensureFile(targetPath, url, expectedSha256, expectedBytes, fallbackPath) {
  const absPath = path.resolve(targetPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });

  if (fs.existsSync(absPath)) {
    if (expectedBytes !== undefined && fs.statSync(absPath).size !== expectedBytes) {
      console.log(`Size mismatch for ${targetPath}, re-fetching...`);
    } else if (expectedSha256 !== undefined && calcSha256(absPath) !== expectedSha256) {
      console.log(`SHA256 mismatch for ${targetPath}, re-fetching...`);
    } else {
      console.log(`[OK] Already valid: ${targetPath}`);
      return;
    }
  }

  // Fallback to local sibling directory if available
  if (fallbackPath && fs.existsSync(fallbackPath)) {
    const fallbackSize = fs.statSync(fallbackPath).size;
    if (expectedBytes === undefined || fallbackSize === expectedBytes) {
      const fallbackSha = calcSha256(fallbackPath);
      if (expectedSha256 === undefined || fallbackSha === expectedSha256) {
        console.log(`[COPY] Using verified local copy from ${fallbackPath} -> ${targetPath}`);
        fs.copyFileSync(fallbackPath, absPath);
        return;
      }
    }
  }

  // Download from URL
  await downloadFile(url, absPath);

  // Validate
  if (expectedBytes !== undefined) {
    const size = fs.statSync(absPath).size;
    if (size !== expectedBytes) {
      throw new Error(`Size verification failed for ${targetPath}: expected ${expectedBytes}, got ${size}`);
    }
  }
  if (expectedSha256 !== undefined) {
    const sha = calcSha256(absPath);
    if (sha !== expectedSha256) {
      throw new Error(`SHA256 verification failed for ${targetPath}: expected ${expectedSha256}, got ${sha}`);
    }
  }
  console.log(`[OK] Downloaded and verified: ${targetPath}`);
}

async function main() {
  console.log("=== 1. Setting up sqlite-official ===");
  const officialSrc = path.resolve("../sqlite-vec1-embeddinggemma2-wasm5/downloads/sqlite-official");
  const officialDest = path.resolve("downloads/sqlite-official");
  fs.mkdirSync(officialDest, { recursive: true });
  if (fs.existsSync(officialSrc)) {
    const files = fs.readdirSync(officialSrc);
    for (const f of files) {
      const srcFile = path.join(officialSrc, f);
      const destFile = path.join(officialDest, f);
      fs.copyFileSync(srcFile, destFile);
      console.log(`[COPIED] sqlite-official/${f} (${fs.statSync(destFile).size} bytes)`);
    }
  } else {
    console.warn(`[WARN] ${officialSrc} not found!`);
  }

  console.log("\n=== 2. Downloading downloads/*.tgz / .tar.gz ===");
  for (const item of DOWNLOAD_ITEMS) {
    const fallback = path.resolve("../sqlite-vec1-embeddinggemma2-wasm5", item.target);
    await ensureFile(item.target, item.url, undefined, undefined, fallback);
  }

  console.log("\n=== 3. Downloading EmbeddingGemma 2 Model assets ===");
  for (const item of MODEL_ITEMS) {
    const targetPath = path.join(MODEL_DIR, item.file);
    const fallback = path.resolve("../sqlite-vec1-embeddinggemma2-wasm5", targetPath);
    await ensureFile(targetPath, item.url, item.expectedSha256, item.bytes, fallback);
  }

  console.log("\n=== 4. Summary ===");
  console.log("Downloads files:");
  fs.readdirSync("downloads").forEach(f => {
    const p = path.join("downloads", f);
    if (fs.statSync(p).isFile()) {
      console.log(`  downloads/${f}: ${fs.statSync(p).size} bytes`);
    }
  });
  console.log("sqlite-official files:");
  fs.readdirSync("downloads/sqlite-official").forEach(f => {
    const p = path.join("downloads/sqlite-official", f);
    console.log(`  downloads/sqlite-official/${f}: ${fs.statSync(p).size} bytes`);
  });
  console.log("Model files:");
  fs.readdirSync(MODEL_DIR).forEach(f => {
    const p = path.join(MODEL_DIR, f);
    console.log(`  ${MODEL_DIR}/${f}: ${fs.statSync(p).size} bytes`);
  });

  console.log("\nAll assets downloaded and verified successfully!");
}

main().catch(err => {
  console.error("Error downloading assets:", err);
  process.exit(1);
});
