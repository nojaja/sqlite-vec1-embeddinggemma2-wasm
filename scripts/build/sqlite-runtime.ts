const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

/**
 * 処理名: SQLite 再生成ランナースクリプト
 * 処理概要: docs/spec/v0.0.1/build.md 第2項に従い、docker/sqlite-runtime-build を用いて
 *           emscripten/emsdk:6.0.8 コンテナを起動し、SQLite 3.54.1 + vec1 0.8 組み込みランタイム
 *           （8 ファイル）を downloads/sqlite-official/ 配下に生成・検証する。
 * 実装理由: ホスト環境から一貫したコマンドで決定論的コンテナ再生成を自動実行するため。
 */
async function main() {
  console.log("=== Launching SQLite 3.54.1 + vec1 0.8 Rebuild Container ===");
  const rootDir = process.cwd();

  // 入力資材の存在確認
  const requiredInputs = [
    "downloads/sqlite-src-3540100.zip",
    "downloads/vec1.c"
  ];
  for (const input of requiredInputs) {
    const fullPath = path.resolve(rootDir, input);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Required build input missing: ${input}. Run 'node scripts/download-assets.mjs' first.`);
    }
  }

  // 出力ディレクトリ準備
  const outputDir = path.resolve(rootDir, "downloads/sqlite-official");
  fs.mkdirSync(outputDir, { recursive: true });

  const buildScriptLinuxPath = "/workspace/docker/sqlite-runtime-build/build-sqlite.sh";

  console.log(`Working Directory: ${rootDir}`);
  console.log(`Starting docker container with image emscripten/emsdk:6.0.8...`);

  // Docker コマンドの構築
  // Windows パスを Docker ボリュームマウント形式へ安全に渡す
  const dockerArgs = [
    "run",
    "--rm",
    "-v",
    `${rootDir}:/workspace`,
    "-w",
    "/workspace",
    "emscripten/emsdk:6.0.8",
    "bash",
    buildScriptLinuxPath
  ];

  try {
    childProcess.execFileSync("docker", dockerArgs, {
      stdio: "inherit"
    });
    console.log("\n[SUCCESS] SQLite official runtime assets rebuild completed successfully!");
  } catch (err) {
    console.error("\n[ERROR] Docker execution failed:", err.message);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
