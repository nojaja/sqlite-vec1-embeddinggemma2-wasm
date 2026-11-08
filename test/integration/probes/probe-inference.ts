import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { embeddingToBlob, assertTokenLimit } from "../../../src/inference/profile";
import { MODEL_ASSET_FILES, MODEL_REPOSITORY, MODEL_REVISION, type ModelAssetDigest } from "../../../src/runtime-assets/model-contract";

const inferenceRuntime = require(resolve("dist/vendor/transformers-portable-node.js"));
const inferenceRoot = resolve("model/embeddinggemma-2-ONNX", MODEL_REVISION);
let inferencePhase = "initialize";
let forbiddenFetches = 0;
const assetTrace = new Set<string>();
let manifestAssets: ModelAssetDigest[];
const reportPath = "artifacts/release-gates/inference-report.json";

type PhaseTimings = {
  codecInitElapsedMs: number;
  processorInitElapsedMs: number;
  modelInitElapsedMs: number;
  totalElapsedMs: number;
};

type HistoricalEstimate = {
  fingerprintMatched: boolean;
  modelInitElapsedMs: number | null;
  operationElapsedMs: Record<string, number>;
  inferenceOperationsElapsedMs: number | null;
};

type StoredInferenceReport = {
  fingerprint?: string;
  backend?: string;
  numThreads?: number;
  timings?: Partial<PhaseTimings>;
  results?: Array<{ operation?: string; elapsedMs?: number }>;
};

/**
 * 処理名: 過去実績時間の正規化
 * 処理概要: 有限な非負のミリ秒だけを見積値として受理する。
 * 実装理由: 壊れた過去reportから誤った想定時間を表示しないため。
 * @param value - 過去reportから取得した値。
 * @returns 利用可能なミリ秒、または利用不能を表すnull。
 */
function historicalMilliseconds(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

/**
 * 処理名: 過去実績見積読込
 * 処理概要: 前回reportからmodel初期化と各推論の所要時間を取得する。
 * 実装理由: 長時間処理の開始前に実績由来の待ち時間目安を表示するため。
 * @param fingerprint - 現在実行するモデル資材のfingerprint。
 * @returns 利用可能な過去実績とfingerprint一致状態。
 */
async function readHistoricalEstimate(fingerprint: string): Promise<HistoricalEstimate> {
  const unavailable: HistoricalEstimate = { fingerprintMatched: false, modelInitElapsedMs: null, operationElapsedMs: {}, inferenceOperationsElapsedMs: null };
  try {
    const report = JSON.parse(await readFile(reportPath, "utf8")) as StoredInferenceReport;
    if (report.backend !== "wasm" || report.numThreads !== 1) return unavailable;
    const operationElapsedMs: Record<string, number> = {};
    for (const result of report.results ?? []) {
      const elapsedMs = historicalMilliseconds(result.elapsedMs);
      if (typeof result.operation === "string" && elapsedMs !== null) operationElapsedMs[result.operation] = elapsedMs;
    }
    const durations = Object.values(operationElapsedMs);
    return {
      fingerprintMatched: report.fingerprint === fingerprint,
      modelInitElapsedMs: historicalMilliseconds(report.timings?.modelInitElapsedMs),
      operationElapsedMs,
      inferenceOperationsElapsedMs: durations.length > 0 ? durations.reduce((total, value) => total + value, 0) : null
    };
  } catch {
    return unavailable;
  }
}

/**
 * 処理名: 経過時間計測
 * 処理概要: 指定した開始時刻から現在までをミリ秒へ丸める。
 * 実装理由: 全段階で同じ単位と丸め規則の進捗ログを出すため。
 * @param started - performance.nowで取得した開始時刻。
 * @returns 経過ミリ秒。
 */
function elapsedMilliseconds(started: number): number {
  return Math.round(performance.now() - started);
}

/**
 * 処理名: loader cache key解決
 * 処理概要: 固定repo/revisionのlocal/remote keyだけを論理pathへ変換する。
 * 実装理由: loaderに任意URLや別revisionの資材を渡さないため。
 * @param request - loaderのcache key。
 * @returns 許可された論理pathまたはnull。
 */
function resolveCacheKey(request: string | Request): string | null {
  const key = typeof request === "string" ? request : request.url;
  const prefixes = [`/models/${MODEL_REPOSITORY}/`, `https://huggingface.co/${MODEL_REPOSITORY}/resolve/${MODEL_REVISION}/`];
  for (const prefix of prefixes) {
    if (key.startsWith(prefix)) return key.slice(prefix.length);
  }
  return null;
}

/**
 * 処理名: 検証済みcache応答
 * 処理概要: allowlist資材のsize/hashを毎回確認して新しいResponseを返す。
 * 実装理由: markerやfilenameだけを信頼してモデルを実行しないため。
 * @param request - loaderのcache key。
 * @returns 検証済みResponseまたはcache miss。
 */
async function matchVerifiedCache(request: string | Request): Promise<Response | undefined> {
  const relative = resolveCacheKey(request);
  for (const definition of MODEL_ASSET_FILES) {
    if (definition.path !== relative) continue;
    const expected = manifestAssets.find(findExpectedAsset);
    /**
     * 処理名: digest照合対象選択
     * 処理概要: 現在の論理pathに対応するmanifest行を選択する。
     * 実装理由: 実ファイルと別資材のhashを誤照合しないため。
     * @param asset - manifest行。
     * @returns 対象行ならtrue。
     */
    function findExpectedAsset(asset: ModelAssetDigest): boolean { return asset.path === definition.path; }
    assert.ok(expected);
    const bytes = await readFile(join(inferenceRoot, definition.source));
    assert.equal(bytes.length, expected.bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), expected.sha256);
    assetTrace.add(definition.path);
    return new Response(Uint8Array.from(bytes), { headers: { "Content-Length": String(bytes.length), "Content-Type": definition.mime } });
  }
  return undefined;
}

/**
 * 処理名: 未許可取得拒否
 * 処理概要: private loaderからの外部fetchを常に拒否する。
 * 実装理由: offline PoTで通信が暗黙発生した場合に必ず検出するため。
 * @returns 必ず拒否するPromise。
 */
async function denyModelFetch(): Promise<never> {
  forbiddenFetches += 1;
  throw new Error("E_UNEXPECTED_FETCH");
}

/**
 * 処理名: cache書込み拒否
 * 処理概要: 読み取り専用の供給adapterへの書込みを拒否する。
 * 実装理由: 検証済みsourceを上流cache機構が変更しないため。
 * @returns 必ず拒否するPromise。
 */
async function denyCachePut(): Promise<never> {
  throw new Error("E_CACHE_READ_ONLY");
}

/**
 * 処理名: tensor資源解放
 * 処理概要: model/processor出力中のtensorを一度ずつdisposeする。
 * 実装理由: 画像とテキストの連続処理で中間tensorを蓄積しないため。
 * @param collection - 入出力の集合。
 */
function disposeTensors(collection: Record<string, unknown>): void {
  const disposed = new Set<unknown>();
  for (const value of Object.values(collection)) {
    if (typeof value !== "object" || value === null || disposed.has(value)) continue;
    if ("dispose" in value && typeof value.dispose === "function") value.dispose();
    disposed.add(value);
  }
}

/**
 * 処理名: 実モデルoffline検証
 * 処理概要: 固定q4のtext/vision sessionから実embeddingを取得する。
 * 実装理由: backend選択やcodec単体の成功を実推論と混同しないため。
 * @returns 検証と資源解放の完了。
 */
async function probeInference(): Promise<void> {
  const probeStarted = performance.now();
  const manifest = JSON.parse(await readFile("manifests/embeddinggemma2-q4.json", "utf8")) as { assets: ModelAssetDigest[]; fingerprint: string };
  manifestAssets = manifest.assets;
  const estimate = await readHistoricalEstimate(manifest.fingerprint);
  console.log(JSON.stringify({ stage: "historical-estimate", source: reportPath, ...estimate }));
  const env = inferenceRuntime.env;
  Object.assign(env, { useCustomCache: true, customCache: { match: matchVerifiedCache, put: denyCachePut }, useBrowserCache: false, useFSCache: false, useFS: false, allowLocalModels: true, allowRemoteModels: false, localModelPath: "/models/", useWasmCache: false, fetch: denyModelFetch });
  Object.assign(env.backends.onnx.wasm, { numThreads: 1, proxy: false, wasmPaths: { wasm: pathToFileURL(resolve("dist/ort/ort-wasm-simd-threaded.jsep.wasm")).href, mjs: pathToFileURL(resolve("dist/ort/ort-wasm-simd-threaded.jsep.mjs")).href } });
  inferencePhase = "codec-init";
  const codecInitStarted = performance.now();
  console.log(JSON.stringify({ stage: inferencePhase, status: "started", estimatedMs: null }));
  await inferenceRuntime.initializeImageCodecs({ jpeg: await readFile("dist/image/jpeg.wasm"), png: await readFile("dist/image/png.wasm"), resize: await readFile("dist/image/resize.wasm") });
  const codecInitElapsedMs = elapsedMilliseconds(codecInitStarted);
  console.log(JSON.stringify({ stage: inferencePhase, status: "passed", elapsedMs: codecInitElapsedMs }));
  const localOptions = { revision: MODEL_REVISION, local_files_only: true };
  inferencePhase = "processor-init";
  const processorInitStarted = performance.now();
  console.log(JSON.stringify({ stage: inferencePhase, status: "started", estimatedMs: null }));
  const config = await inferenceRuntime.AutoConfig.from_pretrained(MODEL_REPOSITORY, localOptions);
  config.audio_config = null;
  const processor = await inferenceRuntime.AutoProcessor.from_pretrained(MODEL_REPOSITORY, localOptions);
  const processorInitElapsedMs = elapsedMilliseconds(processorInitStarted);
  console.log(JSON.stringify({ stage: inferencePhase, status: "passed", elapsedMs: processorInitElapsedMs }));
  inferencePhase = "model-init";
  const modelInitStarted = performance.now();
  console.log(JSON.stringify({ stage: inferencePhase, status: "started", backend: "wasm", numThreads: 1, estimatedMs: estimate.modelInitElapsedMs, estimatedFollowingInferenceMs: estimate.inferenceOperationsElapsedMs }));
  const model = await inferenceRuntime.AutoModel.from_pretrained(MODEL_REPOSITORY, { ...localOptions, config, device: "wasm", dtype: { model: "q4", vision_encoder: "q4" } });
  const modelInitElapsedMs = elapsedMilliseconds(modelInitStarted);
  console.log(JSON.stringify({ stage: inferencePhase, status: "passed", elapsedMs: modelInitElapsedMs }));
  const results = [];
  try {
    for (const operation of ["text", "image"]) {
      inferencePhase = operation;
      const started = performance.now();
      console.log(JSON.stringify({ stage: operation, status: "started", estimatedMs: estimate.operationElapsedMs[operation] ?? null }));
      const imageBytes = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64"));
      const image = operation === "image" ? await inferenceRuntime.decodeRawImage(imageBytes, "image/png") : null;
      const inputs = await processor(operation === "text" ? "task: search result | query: vector search" : null, image);
      assertTokenLimit(inputs.input_ids.data.length);
      let outputs: Record<string, unknown> = {};
      try {
        outputs = await model(inputs);
        const embedding = outputs.sentence_embedding as { data: Float32Array; dims: number[] };
        const blob = embeddingToBlob(embedding.data, embedding.dims);
        const elapsedMs = elapsedMilliseconds(started);
        results.push({ operation, dimension: 768, bytes: blob.length, elapsedMs });
        console.log(JSON.stringify({ stage: operation, status: "passed", bytes: blob.length, elapsedMs }));
      } finally { disposeTensors(inputs); disposeTensors(outputs); }
    }
  } finally { await model.dispose(); }
  assert.equal(forbiddenFetches, 0);
  for (const path of assetTrace) assert.equal(path.includes("audio_encoder"), false);
  await mkdir("artifacts/release-gates", { recursive: true });
  const timings: PhaseTimings = { codecInitElapsedMs, processorInitElapsedMs, modelInitElapsedMs, totalElapsedMs: elapsedMilliseconds(probeStarted) };
  const report = { stage: "real-q4-inference", backend: "wasm", numThreads: 1, fingerprint: manifest.fingerprint, forbiddenFetches, assets: [...assetTrace], timings, results, status: "passed" };
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(JSON.stringify(report));
}

/**
 * 処理名: 実推論失敗通知
 * 処理概要: 内容を伏せて段階とcodeを記録する。
 * 実装理由: 上流例外の入力内容や絶対pathを公開しないため。
 * @param failure - 検証失敗。
 */
function reportInferenceFailure(failure: unknown): void {
  const code = typeof failure === "object" && failure !== null && "code" in failure ? String(failure.code) : "E_INFERENCE";
  console.error(JSON.stringify({ stage: inferencePhase, code, status: "failed" }));
  process.exitCode = 1;
}

probeInference().catch(reportInferenceFailure);