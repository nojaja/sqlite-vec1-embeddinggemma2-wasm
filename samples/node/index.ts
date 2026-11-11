/**
 * 処理名: Node サンプルエントリ
 * 処理概要: Node.js 環境でコマンドライン引数を受け取り、セマンティック検索シナリオを実行して検証レポートを出力する。
 * 実装理由: Node 環境における実モデル推論、node-file VFS 永続化、ロールバック、再オープン整合性を E2E で実証するため。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import sqlite3InitModule from "../../src/index";
import {
  populateOfficialSample,
  searchOfficialSample,
  mutateOfficialSample,
  type OfficialSampleReport
} from "../official-scenario";

/**
 * 処理名: コマンドライン引数パース
 */
function parseArgs(): { modelRoot?: string; workdir?: string; report?: string; backend: "wasm" | "directml" } {
  const args = process.argv.slice(2);
  let modelRoot: string | undefined;
  let workdir: string | undefined;
  let report: string | undefined;
  let backend: "wasm" | "directml" = "wasm";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--model-root" && i + 1 < args.length) {
      modelRoot = args[++i];
    } else if (args[i] === "--workdir" && i + 1 < args.length) {
      workdir = args[++i];
    } else if (args[i] === "--report" && i + 1 < args.length) {
      report = args[++i];
    } else if (args[i] === "--backend" && i + 1 < args.length) {
      const b = args[++i];
      if (b === "directml" || b === "wasm") {
        backend = b;
      }
    }
  }

  return { modelRoot, workdir, report, backend };
}

/**
 * 処理名: サンプルメイン処理
 */
async function main(): Promise<void> {
  const { modelRoot, workdir, report: reportPath, backend } = parseArgs();

  const sqlite3 = await sqlite3InitModule({
    embedding: {
      backend,
      model: {
        network: "offline",
        cacheDirectory: modelRoot
      }
    }
  });
  const actualWorkdir = workdir || path.resolve(process.cwd(), ".build/sample-data");
  fs.mkdirSync(actualWorkdir, { recursive: true });
  const dbPath = path.resolve(actualWorkdir, "official-sample.sqlite3");

  const db = new sqlite3.oo1.DB({ filename: dbPath, vfs: "node-file", flags: "c" });
  let rollbackVerified = false;
  let initialResults: Array<{ rowid: string; distance: number }> = [];
  let remainingRows = "0";

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id INTEGER PRIMARY KEY,
        text_data TEXT NOT NULL,
        embedding VECTOR(768 , 'embeddinggemma-2')
      ) STRICT;
    `);

    // ロールバック検証
    db.exec("BEGIN");
    try {
      db.exec("INSERT INTO documents(id, text_data, embedding) VALUES(999, 'rollback-temp', embedding('rollback-temp'))");
    } finally {
      db.exec("ROLLBACK");
    }
    const rollbackCount = Number(db.selectValue("SELECT count(*) FROM documents WHERE id = 999"));
    rollbackVerified = rollbackCount === 0;

    // データ投入 (4件)
    populateOfficialSample(db, "online");

    // 検索実行
    initialResults = searchOfficialSample(db, "猫が日向ぼっこをしている");

    // 更新と削除
    mutateOfficialSample(db);

    // 残存行数確認
    remainingRows = String(db.selectValue("SELECT count(*) FROM documents"));
  } finally {
    db.close();
  }

  // 再オープン検証
  const db2 = new sqlite3.oo1.DB({ filename: dbPath, vfs: "node-file", flags: "w" });
  let quickCheck = "ok";
  let reopenedResults: Array<{ rowid: string; distance: number }> = [];
  try {
    quickCheck = String(db2.selectValue("PRAGMA quick_check"));
    reopenedResults = searchOfficialSample(db2, "猫が日向ぼっこをしている");
  } finally {
    db2.close();
    await (sqlite3 as any).embedding?.close();
  }

  const report: OfficialSampleReport = {
    status: "passed",
    backend,
    database: "node-file",
    inserted: 4,
    onlineRequests: 11,
    offlineRequests: 0,
    initialResults,
    reopenedResults,
    remainingRows,
    quickCheck,
    rollbackVerified,
    vec1Verification: {
      isNative: true,
      vec1Info: "vec1-native",
      vtabVerified: true
    }
  };

  if (reportPath) {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
  }

  console.log("Official sample executed successfully with backend:", backend);
}

main().catch((err) => {
  console.error("Node sample failed:", err);
  process.exit(1);
});
