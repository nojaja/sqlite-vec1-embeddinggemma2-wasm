const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const childProcess = require("node:child_process");

/**
 * 処理名: SHA-256 ダイジェスト算出
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
 * 処理名: 全資材ロック主処理
 * 処理概要: ビルド入力資材（downloads/）および推論モデル資材（model/）の完全性を一括検証・ロックする。
 */
async function main() {
  console.log("=== Locking All Assets (lock-assets) ===");

  // 1. モデルマニフェストのロック
  console.log("\n[1/2] Locking Model Manifest...");
  childProcess.execFileSync(process.execPath, ["scripts/assets/lock-model.ts"], { stdio: "inherit" });

  // 2. ビルド入力資材（downloads/）の検証
  console.log("\n[2/2] Verifying Downloaded Build Inputs...");
  const expectedDownloads = [
    {
      path: "downloads/sqlite-src-3540100.zip",
      bytes: 14899528,
      sha256: "387e7f6cad4797b17848c07d453dc6606917bb356a6cfe5a3abafd38c240c71b"
    },
    {
      path: "downloads/vec1.c",
      bytes: 378128,
      sha256: "a38c62274093bec34631831371ad433703d6dde7fa9ecd6088da4ed33d4a61f9"
    },
    {
      path: "downloads/sqlite-wasm-ccbb81134a3b5a824f8a3cc3c5d8edd6e799ab5a.tar.gz",
      bytes: 1221483,
      sha256: "8a428f3330278c96073c6afda8d8a51921a18a330000f99645c5d7051409a795"
    }
  ];

  for (const item of expectedDownloads) {
    const fullPath = path.resolve(item.path);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Missing build input asset: ${item.path}`);
    }
    const stat = fs.statSync(fullPath);
    if (stat.size !== item.bytes) {
      throw new Error(`Size mismatch for ${item.path}: expected ${item.bytes}, got ${stat.size}`);
    }
    const sha = await calcSha256(fullPath);
    if (sha.toLowerCase() !== item.sha256.toLowerCase()) {
      throw new Error(`SHA256 mismatch for ${item.path}: expected ${item.sha256}, got ${sha}`);
    }
    console.log(`[VERIFIED] ${item.path} (${stat.size} bytes, sha256: ${sha.substring(0, 16)}...)`);
  }

  console.log("\nAll assets verified and locked successfully!");
}

main().catch((err) => {
  console.error("Error locking assets:", err);
  process.exit(1);
});
