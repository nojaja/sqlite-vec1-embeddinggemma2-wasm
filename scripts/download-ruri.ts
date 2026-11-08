import { createWriteStream, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const BASE_URL = "https://huggingface.co/sirasagi62/ruri-v3-130m-ONNX/resolve/main/";
const TARGET_DIR = resolve("model/ruri-v3-130m-ONNX");

const FILES_TO_DOWNLOAD = [
  "config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "special_tokens_map.json",
  "onnx/model_q4.onnx"
];

async function downloadFile(relPath: string): Promise<void> {
  const targetPath = resolve(TARGET_DIR, relPath);
  if (existsSync(targetPath)) {
    console.log(`[SKIP] 既に存在します: ${relPath}`);
    return;
  }
  mkdirSync(dirname(targetPath), { recursive: true });

  const url = BASE_URL + relPath;
  console.log(`[DOWNLOAD] ${relPath} をダウンロード中... (${url})`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }

  const writeStream = createWriteStream(targetPath);
  // @ts-ignore
  await pipeline(Readable.fromWeb(response.body), writeStream);
  console.log(`[DONE] ${relPath} のダウンロードが完了しました。`);
}

async function main(): Promise<void> {
  console.log("=== Ruri-v3 (130m ONNX Q4) モデルダウンロード開始 ===");
  mkdirSync(TARGET_DIR, { recursive: true });

  for (const file of FILES_TO_DOWNLOAD) {
    await downloadFile(file);
  }
  console.log("=== 全ての Ruri-v3 モデル資材の準備が完了しました ===");
}

main().catch((err) => {
  console.error("ダウンロード失敗:", err);
  process.exit(1);
});
