import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import initialize from "../../src/official/node";
import { populateOfficialSample, searchOfficialSample, mutateOfficialSample } from "../official-scenario";
import { MODEL_ASSET_FILES } from "../../src/runtime-assets/model-contract";

/**
 * 処理名: CLI引数構造定義
 * 処理概要: サンプル実行に必要なコマンドライン引数の型を定義する。
 * 実装理由: CLIオプションを型安全に受け渡しするため。
 */
interface CliArgs {
  modelRoot: string;
  workdir: string;
  report: string;
  backend: "wasm" | "directml";
}

/**
 * 処理名: CLI引数パース
 * 処理概要: コマンドライン引数を走査し、CliArgsオブジェクトを構築する。
 * 実装理由: 実行時オプションを構造化して取得するため。
 * @returns パースされたCLI引数オブジェクト。
 */
function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let modelRoot = "";
  let workdir = "";
  let report = "";
  let backend: "wasm" | "directml" = "wasm";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--model-root") modelRoot = resolve(args[++i]!);
    else if (args[i] === "--workdir") workdir = resolve(args[++i]!);
    else if (args[i] === "--report") report = resolve(args[++i]!);
    else if (args[i] === "--backend") backend = args[++i]! as "wasm" | "directml";
  }

  return { modelRoot, workdir, report, backend };
}

if (isMainThread) {
  const cliArgs = parseArgs();
  let onlineRequests = 0;
  let offlineRequests = 0;
  let currentMode: "online" | "offline" = "online";

  // Local model server to count online/offline requests
  const files = new Map(MODEL_ASSET_FILES.map((asset) => [
    `/${asset.path}`,
    { filename: resolve(cliArgs.modelRoot, asset.source), mime: asset.mime }
  ]));

  const server = createServer((req, res) => {
    if (currentMode === "online") onlineRequests++;
    else offlineRequests++;

    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    const asset = files.get(path);
    if (req.method !== "GET" || asset === undefined) {
      res.writeHead(404).end();
      return;
    }
    readFile(asset.filename)
      .then((bytes) => {
        res.writeHead(200, {
          "Content-Type": asset.mime,
          "Content-Length": String(bytes.length),
          "Cache-Control": "no-store"
        });
        res.end(bytes);
      })
      .catch(() => res.writeHead(500).end());
  });

  server.listen(0, "127.0.0.1", async () => {
    const address = server.address() as { port: number };
    const baseUrl = `http://127.0.0.1:${address.port}/`;

    await mkdir(cliArgs.workdir, { recursive: true });

    const worker = new Worker(__filename, {
      workerData: { ...cliArgs, baseUrl }
    });

    worker.on("message", async (msg) => {
      if (msg.kind === "set-mode") {
        currentMode = msg.mode;
        worker.postMessage({ kind: "mode-set" });
      } else if (msg.kind === "done") {
        server.close();
        const finalReport = {
          ...msg.report,
          onlineRequests,
          offlineRequests
        };
        await writeFile(cliArgs.report, JSON.stringify(finalReport, null, 2) + "\n", "utf8");
        process.exit(0);
      }
    });

    worker.on("error", (err) => {
      console.error(err);
      server.close();
      process.exit(1);
    });

    worker.on("exit", (code) => {
      if (code !== 0) {
        server.close();
        process.exit(code ?? 1);
      }
    });
  });
} else {
  // Worker Thread
  const { workdir, backend, baseUrl } = workerData as CliArgs & { baseUrl: string };
  const dbPath = join(workdir, "sample.sqlite3");
  const cacheDirectory = join(workdir, "model-cache");

  /**
   * 処理名: ネットワークモード切替
   * 処理概要: 親スレッドにモード変更を通知し、切替完了を待機する。
   * 実装理由: オンライン/オフラインのシナリオ検証を同期的に制御するため。
   * @param mode - 切り替えるネットワークモード。
   * @returns 切替完了Promise。
   */
  async function setMode(mode: "online" | "offline"): Promise<void> {
    return new Promise((done) => {
      /**
       * 処理名: モード設定応答ハンドラ
       * 処理概要: 親スレッドからのmode-set完了通知を受信してPromiseを解決する。
       * 実装理由: 親スレッド側のモード切替完了を検出するため。
       * @param msg - 親スレッドからのメッセージオブジェクト。
       */
      const onMsg = (msg: unknown) => {
        if (typeof msg === "object" && msg !== null && "kind" in msg && (msg as { kind: unknown }).kind === "mode-set") {
          parentPort?.off("message", onMsg);
          done();
        }
      };
      parentPort?.on("message", onMsg);
      parentPort?.postMessage({ kind: "set-mode", mode });
    });
  }

  /**
   * 処理名: サンプルシナリオ実行
   * 処理概要: オンライン初期化、オフライン初期化、データ登録・検索・更新シナリオを順次実行する。
   * 実装理由: Node環境での公式シナリオの透過実行を検証するため。
   * @returns 実行完了Promise。
   */
  async function runScenario(): Promise<void> {
    await setMode("online");

    // 1. Initial run: online
    const sqlite3Online = await initialize({
      embedding: {
        backend,
        cacheDirectory,
        model: {
          baseUrl,
          network: "allow"
        }
      }
    });

    const db1 = new sqlite3Online.oo1.DB({ filename: dbPath, vfs: "node-file", flags: "c" });
    await populateOfficialSample(db1);

    // Rollback verification
    db1.exec("BEGIN TRANSACTION; INSERT INTO docs(id, title, body) VALUES(999, 'temp', 'temp'); ROLLBACK;");
    const rollbackVerified = db1.selectValue("SELECT count(*) FROM docs WHERE id = 999") === 0;

    const initialResults = await searchOfficialSample(db1, "猫");
    await mutateOfficialSample(db1);
    db1.close();
    await sqlite3Online.embedding?.close();

    // 2. Re-opened run: offline
    await setMode("offline");
    const sqlite3Offline = await initialize({
      embedding: {
        backend,
        cacheDirectory,
        model: {
          baseUrl,
          network: "offline"
        }
      }
    });

    const db2 = new sqlite3Offline.oo1.DB({ filename: dbPath, vfs: "node-file", flags: "c" });
    const reopenedResults = await searchOfficialSample(db2, "猫");
    const remainingRows = String(db2.selectValue("SELECT count(*) FROM docs"));
    const quickCheck = String(db2.selectValue("PRAGMA quick_check"));
    db2.close();
    await sqlite3Offline.embedding?.close();

    parentPort?.postMessage({
      kind: "done",
      report: {
        status: "passed",
        backend,
        database: "node-file",
        inserted: 4,
        remainingRows,
        quickCheck,
        rollbackVerified,
        initialResults,
        reopenedResults
      }
    });
  }

  runScenario().catch((err) => {
    console.error("Worker scenario failed:", err);
    process.exit(1);
  });
}
