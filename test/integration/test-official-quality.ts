import { readFile, mkdir, writeFile, realpath, lstat } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { evaluateEmbeddingQuality, type EmbeddingQualityPair } from "../../src/inference/embedding-quality";
import { validateEmbeddingBlob } from "../../src/inference/statement-embedding-cache";
import { startLocalModelServer } from "./local-model-server";
import type { ProductInitOptions, ProductSqlite3 } from "../../src/official/types";

/** 処理名: 固定品質source。処理概要: 実推論の本文と画像pathだけを表す。実装理由: 参照vectorを推論入力の代用にしないため。 */
interface QualitySources { texts: Array<{ id: string; text: string }>; images: Array<{ id: string; path: string }> }
/** 処理名: 固定品質参照。処理概要: IDと独立FP32参照の対応を表す。実装理由: 同じfixture以外のvectorと比較しないため。 */
interface QualityReferences { fixtures: Array<{ id: string; conversionVector: string }> }

/** 処理名: 品質file境界。処理概要: canonical root内の通常fileだけを読む。実装理由: fixtureのtraversalやsymlinkを拒否するため。
 * @param root - 許可root。
 * @param name - root相対file。
 * @returns file bytes。
 */
async function qualityBytes(root: string, name: string): Promise<Uint8Array> {
  const filename = resolve(root, name);
  const path = relative(await realpath(root), await realpath(filename));
  const metadata = await lstat(filename);
  if (path.startsWith("..") || isAbsolute(path) || metadata.isSymbolicLink() || !metadata.isFile()) throw new Error("QUALITY_PATH_INVALID");
  return new Uint8Array(await readFile(filename));
}

/** 処理名: 品質LE vector復号。処理概要: 実3072-byte BLOBを独立Float32配列へ変換する。実装理由: host endianや共有bufferへ依存しないため。
 * @param bytes - BLOB。
 * @returns 768次元vector。
 */
function qualityVector(bytes: Uint8Array): Float32Array {
  if (bytes.byteLength !== 3072) throw new Error("QUALITY_VECTOR_SIZE");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Float32Array.from({ length: 768 }, (_value, index) => view.getFloat32(index * 4, true));
}

/** 処理名: 本配布API品質再推論。処理概要: 同じ公式接続で全固定text/imageをSQL推論する。実装理由: 過去のq4 vectorを新配布物の成功へ転記しないため。
 * @returns 品質report。
 */
async function runOfficialQualityOwner(): Promise<Record<string, unknown>> {
  const options = workerData as { backend: "wasm" | "directml"; baseUrl: string };
  const initialize = (require(resolve("dist/node/index.js")) as { default: (options?: ProductInitOptions) => Promise<ProductSqlite3> }).default;
  const sqlite3 = await initialize({ embedding: { backend: options.backend, cacheDirectory: resolve(".build/official-model-cache"), model: { network: "allow", baseUrl: options.baseUrl }, sqlTimeoutMs: 600000 } });
  const database = new sqlite3.oo1.DB(":memory:");
  try {
    const root = resolve("fixtures/embedding-quality");
    const sources = JSON.parse(await readFile(resolve(root, "source/source-manifest.json"), "utf8")) as QualitySources;
    const references = JSON.parse(await readFile(resolve(root, "manifest.json"), "utf8")) as QualityReferences;
    const byId = new Map(references.fixtures.map((fixture) => [fixture.id, fixture.conversionVector]));
    if (sources.texts.length < 100 || sources.images.length < 32) throw new Error("QUALITY_FIXTURE_COUNT");
    const pairs: EmbeddingQualityPair[] = [];
    const inputs = [...sources.texts.map((item) => ({ ...item, modality: "text" as const })), ...sources.images.map((item) => ({ ...item, modality: "image" as const }))];
    for (const item of inputs) {
      parentPort?.postMessage({ kind: "progress", completed: pairs.length, total: inputs.length, modality: item.modality });
      const referencePath = byId.get(item.id);
      if (referencePath === undefined) throw new Error("QUALITY_REFERENCE_MISSING");
      const value = item.modality === "text" ? database.selectValue("SELECT embedding_query(?)", [item.text]) : database.selectValue("SELECT gemma_embed_image(?,'image/png')", [await qualityBytes(resolve(root, "source"), item.path)]);
      if (!(value instanceof Uint8Array)) throw new Error("QUALITY_EMBEDDING_TYPE");
      validateEmbeddingBlob(value);
      pairs.push({ id: item.id, modality: item.modality, candidate: qualityVector(value), reference: qualityVector(await qualityBytes(root, referencePath)) });
    }
    const result = evaluateEmbeddingQuality(pairs, { text: { mean: 0.98, each: 0.9 }, image: { mean: 0.96, each: 0.9 } });
    if (!result.passed) throw new Error("QUALITY_THRESHOLD_FAILED");
    return { stage: "official-product-embedding-quality", status: "passed", backend: options.backend, inputSource: "fixed-source-manifest", text: sources.texts.length, image: sources.images.length, q4VsConversion: result };
  } finally { try { database.close(); } finally { await sqlite3.embedding.close(); } }
}

/** 処理名: 実配布品質supervisor。処理概要: 所有Workerを有限実行し集計reportだけを保存する。実装理由: 本文/vectorをログやreportへ出さないため。
 * @returns 品質受入完了。
 */
async function superviseOfficialQuality(): Promise<void> {
  const backend = process.argv[2] ?? "wasm";
  if (backend !== "wasm" && backend !== "directml") throw new Error("E_INPUT");
  const server = await startLocalModelServer();
  const worker = new Worker(__filename, { execArgv: [], workerData: { backend, baseUrl: server.baseUrl } });
  try {
    const report = await new Promise<Record<string, unknown>>((complete, reject) => {
      const timer = setTimeout(() => reject(new Error("PRODUCT_QUALITY_TIMEOUT")), 3600000);
      worker.on("message", (message: { kind: string; report?: Record<string, unknown>; completed?: number; total?: number; modality?: string }) => {
        if (message.kind === "progress") { console.log(JSON.stringify({ stage: "product-quality-progress", completed: message.completed, total: message.total, modality: message.modality })); return; }
        clearTimeout(timer);
        if (message.kind === "complete" && message.report) complete(message.report);
        else reject(new Error("PRODUCT_QUALITY_FAILED"));
      });
      worker.once("error", () => { clearTimeout(timer); reject(new Error("PRODUCT_QUALITY_FAILED")); });
    });
    await mkdir("artifacts/release-gates", { recursive: true });
    await writeFile(`artifacts/release-gates/official-quality-${backend}.json`, JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify({ stage: report.stage, status: report.status, backend, text: report.text, image: report.image }));
  } finally { await worker.terminate(); await server.close(); }
}

if (isMainThread) superviseOfficialQuality().catch((failure: unknown) => { console.error(failure instanceof Error ? failure.message : "PRODUCT_QUALITY_FAILED"); process.exitCode = 1; });
else runOfficialQualityOwner().then((report) => { parentPort?.postMessage({ kind: "complete", report }); parentPort?.close(); }).catch(() => { parentPort?.postMessage({ kind: "failed" }); parentPort?.close(); });