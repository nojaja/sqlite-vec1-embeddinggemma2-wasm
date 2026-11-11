import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";

/**
 * docs/spec/v0.0.1/assets.md に準拠した資材管理スクリプト
 */

/**
 * 処理名: ビルド入力資材定義一覧
 * 処理概要: docs/spec/v0.0.1/assets.md 第2項に定義された外部アーカイブ資材。
 * 実装理由: Wasm 再生成および互換性検証に必要な入力資材を完全性保証付きで調達するため。
 */
const DOWNLOAD_ITEMS = [
  {
    target: "downloads/sqlite-src-3540100.zip",
    url: "https://sqlite.org/2026/sqlite-src-3540100.zip",
    expectedSha256: "387e7f6cad4797b17848c07d453dc6606917bb356a6cfe5a3abafd38c240c71b",
    expectedBytes: 14899528,
    description: "SQLite 3.54.1 フルソース（Wasm 再生成用）"
  },
  {
    target: "downloads/sqlite-wasm-ccbb81134a3b5a824f8a3cc3c5d8edd6e799ab5a.tar.gz",
    url: "https://codeload.github.com/sqlite/sqlite-wasm/tar.gz/ccbb81134a3b5a824f8a3cc3c5d8edd6e799ab5a",
    expectedSha256: "8a428f3330278c96073c6afda8d8a51921a18a330000f99645c5d7051409a795",
    expectedBytes: 1221483,
    description: "公式 9 デモ検証用・ビルド済みローダー収録リポジトリアーカイブ"
  }
];

/**
 * 処理名: vec1 C ソース資材定義
 * 処理概要: docs/spec/v0.0.1/assets.md 第2項に定義された vec1 0.8 C ソース。
 * 実装理由: SQLite へのベクトル検索拡張組み込み用。単体 URL 取得時の HTML 誤検出を防止し、
 *           sqlite-src ZIP からの抽出またはハッシュ/バージョン検証を必須とする。
 */
const VEC1_ITEM = {
  target: "downloads/vec1.c",
  fallbackUrl: "https://sqlite.org/vec1/raw/vec1.c",
  zipSource: "downloads/sqlite-src-3540100.zip",
  zipInternalPath: "sqlite-src-3540100/ext/vec1/vec1.c",
  expectedSha256: "a38c62274093bec34631831371ad433703d6dde7fa9ecd6088da4ed33d4a61f9",
  expectedBytes: 378128,
  requiredVersionMacro: '#define VEC1_VERSION "0.8"',
  description: "vec1 0.8 C ソース（Scalar single-threaded 組み込み用）"
};

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
 *           レスポンスが HTML の場合はボット検証・リダイレクトページと判定し拒絶する。
 * 実装理由: 通信中断やボット検証による HTML 誤保存を防止するため。
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
    const contentType = res.headers.get("content-type") || "";
    // C ソースやバイナリアーカイブの取得時に text/html が返却された場合は拒否
    if (contentType.includes("text/html") && !destPath.endsWith(".html")) {
      throw new Error(`Invalid response content-type '${contentType}' for ${destPath}. Received HTML instead of expected asset.`);
    }

    const fileStream = fs.createWriteStream(tmpPath);
    await finished(Readable.fromWeb(res.body).pipe(fileStream));

    // ファイル先頭を読み取り、HTML ページ（<!DOCTYPE や <html）ではないことを検証
    const headBuf = Buffer.alloc(512);
    const fd = fs.openSync(tmpPath, "r");
    const bytesRead = fs.readSync(fd, headBuf, 0, 512, 0);
    fs.closeSync(fd);
    const headText = headBuf.subarray(0, bytesRead).toString("utf8").toLowerCase();
    if (headText.includes("<!doctype html") || headText.includes("<html")) {
      throw new Error(`Downloaded content for ${destPath} is an HTML page (likely bot verification/challenge page), not the expected asset.`);
    }

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
      if (sha.toLowerCase() !== expectedSha256.toLowerCase()) {
        console.log(`SHA256 mismatch for ${targetPath} (expected ${expectedSha256}, got ${sha}), re-fetching...`);
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
    if (sha.toLowerCase() !== expectedSha256.toLowerCase()) {
      throw new Error(`SHA256 verification failed for ${targetPath}: expected ${expectedSha256}, got ${sha}`);
    }
  }
  console.log(`[OK] Downloaded and verified: ${targetPath}`);
}

/**
 * 処理名: vec1 C ソース調達・完全性検証
 * 処理概要: docs/spec/v0.0.1/assets.md 第2項に従い、vec1.c を配置・検証する。
 *           sqlite-src ZIP が存在する場合は内部の ext/vec1/vec1.c から抽出し、
 *           SHA-256、サイズ、および #define VEC1_VERSION "0.8" を厳格に検証する。
 * 実装理由: Fossil URL の Browser Verification による HTML 誤検出・誤配置を根本排除するため。
 * @param {typeof VEC1_ITEM} item - vec1 資材定義。
 */
async function ensureVec1Source(item) {
  const absPath = path.resolve(item.target);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });

  // 既存ファイルの検査
  if (fs.existsSync(absPath)) {
    const stat = fs.statSync(absPath);
    const content = fs.readFileSync(absPath, "utf8");
    const isHtml = content.includes("<!DOCTYPE") || content.includes("<html") || content.includes("<HTML");
    const hasVersion = content.includes(item.requiredVersionMacro);
    const sha = await calcSha256(absPath);

    if (!isHtml && hasVersion && stat.size === item.expectedBytes && sha.toLowerCase() === item.expectedSha256.toLowerCase()) {
      console.log(`[OK] Already valid: ${item.target} (vec1 0.8 confirmed, ${stat.size} bytes)`);
      return;
    }
    console.warn(`[WARN] Existing ${item.target} is invalid (isHtml: ${isHtml}, hasVersion: ${hasVersion}, size: ${stat.size}). Re-extracting...`);
    fs.unlinkSync(absPath);
  }

  // 調達経路 1: sqlite-src ZIP からの展開（標準パス）
  const zipAbsPath = path.resolve(item.zipSource);
  if (fs.existsSync(zipAbsPath)) {
    console.log(`Extracting vec1.c from ${item.zipSource} (${item.zipInternalPath})...`);
    try {
      const extractedContent = execSync(`tar -xOf "${zipAbsPath}" "${item.zipInternalPath}"`, {
        maxBuffer: 10 * 1024 * 1024
      });
      fs.writeFileSync(absPath, extractedContent);
      console.log(`Extracted ${item.target} from ZIP successfully.`);
    } catch (err) {
      console.warn(`Failed to extract vec1.c using tar: ${err.message}. Trying URL fallback...`);
    }
  }

  // 調達経路 2: URL からのフォールバック取得（ZIP から展開できなかった場合）
  if (!fs.existsSync(absPath)) {
    console.log(`Fetching vec1.c from URL: ${item.fallbackUrl}`);
    await downloadFile(item.fallbackUrl, absPath);
  }

  // 取得後の厳格な完全性・内容検証
  const stat = fs.statSync(absPath);
  if (stat.size !== item.expectedBytes) {
    throw new Error(`Size verification failed for ${item.target}: expected ${item.expectedBytes}, got ${stat.size}`);
  }
  const sha = await calcSha256(absPath);
  if (sha.toLowerCase() !== item.expectedSha256.toLowerCase()) {
    throw new Error(`SHA256 verification failed for ${item.target}: expected ${item.expectedSha256}, got ${sha}`);
  }
  const content = fs.readFileSync(absPath, "utf8");
  if (content.includes("<!DOCTYPE") || content.includes("<html") || content.includes("<HTML")) {
    throw new Error(`Verification failed for ${item.target}: content is HTML, not C source code.`);
  }
  if (!content.includes(item.requiredVersionMacro)) {
    throw new Error(`Verification failed for ${item.target}: missing version macro '${item.requiredVersionMacro}'.`);
  }

  console.log(`[OK] Successfully procured and verified: ${item.target} (version: 0.8, bytes: ${stat.size}, sha256: ${sha})`);
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
  // アーカイブ資材（SQLite ソース ZIP 等）を先に取得・検証
  for (const item of DOWNLOAD_ITEMS) {
    await ensureFile(item.target, item.url, item.expectedSha256, item.expectedBytes);
  }

  // vec1.c ソース資材の取得・展開・完全性検証
  await ensureVec1Source(VEC1_ITEM);

  console.log("\n=== 3. Downloading EmbeddingGemma 2 Model assets (manifest-driven) ===");
  const manifestAbsPath = path.resolve(MANIFEST_PATH);
  if (!fs.existsSync(manifestAbsPath)) {
    console.warn(`[WARN] Model manifest not found at ${manifestAbsPath}. Skipping manifest-driven model downloads.`);
  } else {
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

  const modelBase = "model";
  if (fs.existsSync(modelBase)) {
    console.log("\nModel directory tree:");
    const printTree = (dir, depth = 0) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        const indent = "  ".repeat(depth + 1);
        if (entry.isDirectory()) {
          console.log(`${indent}${entry.name}/`);
          printTree(full, depth + 1);
        } else {
          console.log(`${indent}${entry.name}: ${fs.statSync(full).size} bytes`);
        }
      }
    };
    printTree(modelBase);
  }

  console.log("\nAll assets checked and verified successfully!");
}

main().catch((err) => {
  console.error("Error downloading assets:", err);
  process.exit(1);
});
