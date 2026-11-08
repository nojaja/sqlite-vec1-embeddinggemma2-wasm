import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { MODEL_REPOSITORY, MODEL_REVISION } from "../../src/runtime-assets/model-contract";
import { prepareNodeModelCache, type NodeModelCacheOptions } from "../../src/sqlite/node-model-cache";
import { startLocalModelServer } from "./local-model-server";

const REPORT = resolve("artifacts", "release-gates", "g05-assets-report.json");

/**
 * 処理名: gate assertion
 * 処理概要: 不一致を固定messageで停止する。
 * 実装理由: report生成だけを成功にしないため。
 * @param condition - 合格条件。
 * @param message - 失敗識別子。
 */
function assertGate(condition: boolean, message: string): asserts condition { if (!condition) throw new Error(message); }

/**
 * 処理名: online cache検証
 * 処理概要: 全初期化の完了を待ち、成否によらず所有serverを終了する。
 * 実装理由: 並行失敗後の書込みとcleanupの競合を防ぐため。
 * @param common - 共通cache条件。
 * @param count - 同時初期化数。
 * @returns 終了済みserverのURL。
 */
async function prepareOnline(common: Omit<NodeModelCacheOptions, "network" | "baseUrl">, count = 1): Promise<string> {
  const server = await startLocalModelServer();
  try {
    const results = await Promise.allSettled(Array.from({ length: count }, () => prepareNodeModelCache({ ...common, network: "allow", baseUrl: server.baseUrl })));
    for (const result of results) if (result.status === "rejected") throw result.reason;
    return server.baseUrl;
  } finally {
    await server.close();
  }
}

/**
 * 処理名: G05実資材gate
 * 処理概要: online、offline、破損修復、並行初期化、非対象file保持を実bytesで検証する。
 * 実装理由: mock storageだけでoffline保証を完了扱いにしないため。
 * @param root - 今回所有する一時directory。
 * @returns gate完了。
 */
async function runAssetGate(root: string): Promise<void> {
  const manifestBytes = await readFile("manifests/embeddinggemma2-q4.json");
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as { artifactSetHash: string; assets: { path: string; bytes: number; sha256: string }[] };
  const manifestHash = createHash("sha256").update(manifestBytes).digest("hex");
  const cacheDirectory = resolve(root, "cache");
  const unrelated = resolve(cacheDirectory, "sets", "unrelated", "keep.bin");
  const databaseSentinel = resolve(root, "database.sqlite3");
  await mkdir(dirname(unrelated), { recursive: true });
  await writeFile(unrelated, "keep", "utf8");
  await writeFile(databaseSentinel, "db", "utf8");
  const common = { cacheDirectory, assets: manifest.assets, artifactSetHash: manifest.artifactSetHash, manifestHash };
  const baseUrl = await prepareOnline(common);
  const offline = await prepareNodeModelCache({ ...common, network: "offline", baseUrl });
  const key = `https://huggingface.co/${MODEL_REPOSITORY}/resolve/${MODEL_REVISION}/config.json`;
  const cached = await offline.match(key);
  assertGate(cached !== undefined && Number(cached.headers.get("Content-Length")) > 0, "OFFLINE_CACHE_MISS");

  const corruptPath = resolve(cacheDirectory, "sets", manifest.artifactSetHash, "files", "config.json");
  await writeFile(corruptPath, "corrupt", "utf8");
  let corruptRejected = false;
  try { await prepareNodeModelCache({ ...common, network: "offline", baseUrl }); }
  catch { corruptRejected = true; }
  assertGate(corruptRejected, "CORRUPT_CACHE_ACCEPTED");
  await prepareOnline(common);
  assertGate((await readFile(unrelated, "utf8")) === "keep" && (await readFile(databaseSentinel, "utf8")) === "db", "UNRELATED_DATA_REMOVED");

  const concurrentDirectory = resolve(root, "concurrent-cache");
  await prepareOnline({ ...common, cacheDirectory: concurrentDirectory }, 2);

  await mkdir(dirname(REPORT), { recursive: true });
  await writeFile(REPORT, `${JSON.stringify({ gate: "G05", status: "passed", assets: manifest.assets.length, online: true, offline: true, corruptRejected, repaired: true, concurrent: true, unrelatedPreserved: true }, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ gate: "G05", status: "passed", assets: manifest.assets.length }));
}

/**
 * 処理名: 所有領域の回収
 * 処理概要: 新規directoryだけをgateへ渡し、失敗時も削除する。
 * 実装理由: 他runのcacheや利用者DBをcleanup対象にしないため。
 * @returns gateとcleanupの完了。
 */
async function runOwnedAssetGate(): Promise<void> {
  await mkdir(resolve(".build"), { recursive: true });
  const root = await mkdtemp(resolve(".build", "g05-assets-"));
  try { await runAssetGate(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

runOwnedAssetGate().catch((failure: unknown) => {
  console.error(failure instanceof Error ? failure.message : "G05_ASSETS_FAILED");
  process.exitCode = 1;
});
