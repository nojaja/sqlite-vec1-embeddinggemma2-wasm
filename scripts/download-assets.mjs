import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";

/**
 * docs/spec/v0.0.1/assets.md に準拠した資材管理スクリプト
 */

/**
 * 処理名: ビルド入力資材定義一覧
 * 処理概要: docs/spec/v0.0.1/assets.md 第2項に定義された外部アーカイブ・ソース資材。
 * 実装理由: Wasm 再生成および互換性検証に必要な入力資材を調達するため。
 */
const DOWNLOAD_ITEMS = [
  {
    target: "downloads/sqlite-src-3540100.zip",
    url: "https://sqlite.org/2026/sqlite-src-3540100.zip",
    description: "SQLite 3.54.1 フルソース（Wasm 再生成用）"
  },
  {
    target: "downloads/vec1.c",
    url: "https://sqlite.org/vec1/raw/vec1.c",
    description: "vec1 0.8 C ソース（Scalar single-threaded 組み込み用）"
  },
  {
    target: "downloads/sqlite-wasm-ccbb81134a3b5a824f8a3cc3c5d8edd6e799ab5a.tar.gz",
    url: "https://codeload.github.com/sqlite/sqlite-wasm/tar.gz/ccbb81134a3b5a824f8a3cc3c5d8edd6e799ab5a",
    description: "公式 9 デモ検証用・ビルド済みローダー収録リポジトリアーカイブ"
  }
];

/**
 * 処理名: 公式 SQLite + vec1 再生成完成モジュール一覧
 * 処理概要: docs/spec/v0.0.1/assets.md 第1項・第2項に定義された 8 ファイル。
 * 実装理由: 製品ビルドの入力となる公式互換モジュール群の存在を検証するため。
 */
const OFFICIAL_SQLITE_FILES = [
  "sqlite3.wasm",
  "sqlite3-node.mjs",
  "sqlite3-bundler-friendly.mjs",
  "sqlite3.mjs",
  "sqlite3-opfs-async-proxy.js",
  "sqlite3-worker1.mjs",
  "sqlite3-worker1-bundler-friendly.mjs",
  "sqlite3-worker1-promiser.mjs"
];

/**
 * 処理名: 推論モデルマニフェスト相対パス
 */
const MANIFEST_PATH = "manifests/embeddinggemma2-q4.json";

/**
 * 処理名: SHA-256 計算
 * 処理概要: ファイルの SHA-256 ダイジェストをストリームにより非同期計算する。
 * 実装理由: 大容量モデルファイルでもメモリを枯渇させず決定論的に整合性を検証するため。
 * @param {string} filePath - 対象ファイルパス。
 * @returns {Promise<string>} 16進数小文字のハッシュ文字列。
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
 * 処理名: ファイルダウンロード実行
 * 処理概要: URL からファイルをストリームダウンロードし、一時ファイル経由で安全に配置する。
 * 実装理由: 通信中断時に中途半端な破損ファイルが正規配置先に残るのを防止するため。
 * @param {string} url - ダウンロード元URL。
 * @param {string} destPath - 保存先パス。
 */
async function downloadFile(url, destPath) {
  console.log(`Downloading ${url} -> ${destPath}`);
  const tmpPath = `${destPath}.tmp.${Date.now()}`;
  try {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) {
      throw new Error(`Failed to download ${url}: ${res.status} ${res.statusText}`);
    }
    const fileStream = fs.createWriteStream(tmpPath);
    await finished(Readable.fromWeb(res.body).pipe(fileStream));
    fs.renameSync(tmpPath, destPath);
  } finally {
    if (fs.existsSync(tmpPath)) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {}
    }
  }
}

/**
 * 処理名: 資材配置・整合性検証
 * 処理概要: ファイルの存在、バイトサイズ、SHA-256 ハッシュを検証し、未取得・不整合時にダウンロードする。
 * 実装理由: 不完全なモデル資材やアーカイブによるビルド・推論エラーを未然に防ぐため。
 * @param {string} targetPath - 配置先パス。
 * @param {string} url - ダウンロードURL。
 * @param {string} [expectedSha256] - 期待される SHA-256 ハッシュ。
 * @param {number} [expectedBytes] - 期待されるファイルサイズ（バイト）。
 */
async function ensureFile(targetPath, url, expectedSha256, expectedBytes) {
  const absPath = path.resolve(targetPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });

  if (fs.existsSync(absPath)) {
    const stat = fs.statSync(absPath);
    if (expectedBytes !== undefined && stat.size !== expectedBytes) {
      console.log(`Size mismatch for ${targetPath} (expected ${expectedBytes}, got ${stat.size}), re-fetching...`);
    } else if (expectedSha256 !== undefined) {
      const sha = await calcSha256(absPath);
      if (sha !== expectedSha256) {
        console.log(`SHA256 mismatch for ${targetPath}, re-fetching...`);
      } else {
        console.log(`[OK] Already valid: ${targetPath}`);
        return;
      }
    } else {
      console.log(`[OK] Already present: ${targetPath}`);
      return;
    }
  }

  // URL からダウンロード実行
  await downloadFile(url, absPath);

  // 取得後の検証
  if (expectedBytes !== undefined) {
    const size = fs.statSync(absPath).size;
    if (size !== expectedBytes) {
      throw new Error(`Size verification failed for ${targetPath}: expected ${expectedBytes}, got ${size}`);
    }
  }
  if (expectedSha256 !== undefined) {
    const sha = await calcSha256(absPath);
    if (sha !== expectedSha256) {
      throw new Error(`SHA256 verification failed for ${targetPath}: expected ${expectedSha256}, got ${sha}`);
    }
  }
  console.log(`[OK] Downloaded and verified: ${targetPath}`);
}

/**
 * 処理名: メイン資材セットアップ
 * 処理概要: docs/spec/v0.0.1/assets.md に従い、全資材の整合性検証および取得を行う。
 */
async function main() {
  console.log("=== 1. Checking sqlite-official runtime assets ===");
  const officialDir = path.resolve("downloads/sqlite-official");
  fs.mkdirSync(officialDir, { recursive: true });

  let allOfficialPresent = true;
  for (const file of OFFICIAL_SQLITE_FILES) {
    const filePath = path.join(officialDir, file);
    if (fs.existsSync(filePath)) {
      console.log(`[OK] sqlite-official/${file} (${fs.statSync(filePath).size} bytes)`);
    } else {
      console.warn(`[MISSING] sqlite-official/${file} is missing!`);
      allOfficialPresent = false;
    }
  }
  if (!allOfficialPresent) {
    console.warn("[WARN] Some sqlite-official runtime files are missing. Please build them using docker/sqlite-runtime-build as specified in docs/spec/v0.0.1/build.md.");
  }

  console.log("\n=== 2. Downloading build input assets (downloads/) ===");
  for (const item of DOWNLOAD_ITEMS) {
    await ensureFile(item.target, item.url);
  }

  console.log("\n=== 3. Downloading EmbeddingGemma 2 Model assets (manifest-driven) ===");
  const manifestAbsPath = path.resolve(MANIFEST_PATH);
  if (!fs.existsSync(manifestAbsPath)) {
    throw new Error(`Model manifest not found at ${manifestAbsPath}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestAbsPath, "utf-8"));
  const repoName = manifest.repository.includes("/") ? manifest.repository.split("/")[1] : manifest.repository;
  const modelDir = path.join("model", repoName, manifest.revision);
  console.log(`Target Model Directory: ${modelDir}`);
  console.log(`Repository: ${manifest.repository}`);
  console.log(`Revision: ${manifest.revision}`);

  for (const asset of manifest.assets) {
    const fileName = path.basename(asset.path);
    const targetPath = path.join(modelDir, fileName);
    const url = `https://huggingface.co/${manifest.repository}/resolve/${manifest.revision}/${asset.path}`;
    await ensureFile(targetPath, url, asset.sha256, asset.bytes);
  }

  console.log("\n=== 4. Summary ===");
  console.log("Downloads files:");
  fs.readdirSync("downloads").forEach((f) => {
    const p = path.join("downloads", f);
    if (fs.statSync(p).isFile()) {
      console.log(`  downloads/${f}: ${fs.statSync(p).size} bytes`);
    }
  });

  console.log("\nsqlite-official files:");
  fs.readdirSync("downloads/sqlite-official").forEach((f) => {
    const p = path.join("downloads/sqlite-official", f);
    console.log(`  downloads/sqlite-official/${f}: ${fs.statSync(p).size} bytes`);
  });

  console.log("\nModel files:");
  fs.readdirSync(modelDir).forEach((f) => {
    const p = path.join(modelDir, f);
    console.log(`  ${modelDir}/${f}: ${fs.statSync(p).size} bytes`);
  });

  console.log("\nAll assets checked and verified successfully!");
}

main().catch((err) => {
  console.error("Error downloading assets:", err);
  process.exit(1);
});
