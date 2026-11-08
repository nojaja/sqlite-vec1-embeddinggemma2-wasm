import { build, type OnResolveArgs, type OnResolveResult } from "esbuild";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { PortableRuntime } from "../../../src/inference/engine";
import { initializeInferenceEngine, warmupImageBytes } from "../../../src/inference/initialize";
import type { ImageCodecBytes } from "../../../src/inference/image-codecs";
import { MODEL_ASSET_FILES, type ModelAssetDigest } from "../../../src/runtime-assets/model-contract";
import { VerifiedModelCache } from "../../../src/runtime-assets/verified-cache";
import { VectorError } from "../../../src/errors";
import { DirectMlModelCache } from "../../../src/inference/backends/directml-vision-graph";

const upstreamRoot = resolve(".build/directml-validation/transformers");
const upstreamPatchRoot = ".build/directml-validation/transformers";
const outputFile = resolve(".build/directml-validation/transformers-directml-node.js");
const modelRoot = resolve("model/embeddinggemma-2-ONNX/daa72c51243991dfcaf9f9137d2c573d8f7790c0");
let probeStage = "start";

/** 処理名: ORT backend情報。処理概要: provider名と同梱状態を表す。実装理由: DML利用可能性を固定fieldだけで検証するため。 */
interface OrtBackend {
  /** 処理名: provider名。処理概要: ORT内部backend名を保持する。実装理由: DMLだけを選別するため。 */
  name: string;
  /** 処理名: runtime同梱状態。処理概要: backend binaryの有無を表す。実装理由: 未同梱DMLを拒否するため。 */
  bundled: boolean;
}

/** 処理名: ORT値metadata。処理概要: input名、tensor型、shapeだけを表す。実装理由: 入力値を記録せずdynamic dimensionを調査するため。 */
interface OrtValueMetadata {
  /** 処理名: input名。処理概要: graph inputを識別する。実装理由: shapeを入力へ対応付けるため。 */
  name: string;
  /** 処理名: tensor判定。処理概要: shape取得可否を表す。実装理由: 非tensor metadataを安全に扱うため。 */
  isTensor: boolean;
  /** 処理名: tensor型。処理概要: input dtypeを表す。実装理由: dtype差を値なしで診断するため。 */
  type?: string;
  /** 処理名: tensor shape。処理概要: 固定値またはsymbolic dimensionを表す。実装理由: DML dynamic shape失敗を診断するため。 */
  shape?: ReadonlyArray<number | string>;
}

/** 処理名: ORT session診断境界。処理概要: 作成済みsessionのinput metadataだけを公開する。実装理由: PoTの観測範囲を限定するため。 */
interface OrtSession {
  /** 処理名: input metadata。処理概要: graph input契約を保持する。実装理由: dynamic dimension名を取得するため。 */
  inputMetadata: readonly OrtValueMetadata[];
  /** 処理名: profile終了。処理概要: session profileをfileへ確定する。実装理由: provider集計前にraw profileを閉じるため。 */
  endProfiling(): void;
  /** 処理名: session解放。処理概要: native session資源を解放する。実装理由: close cleanupを検証するため。 @returns 解放完了。 */
  release(): Promise<void>;
}

/** 処理名: ORT session factory境界。処理概要: native session生成を表す。実装理由: session作成直後のmetadataを観測するため。 */
interface OrtSessionFactory {
  /** 処理名: session生成。処理概要: ORT引数を変更せずnative factoryへ渡す。実装理由: PoT診断でmodel loader契約を変えないため。 @param args - ORT session引数。 @returns 作成済みsession。 */
  create(...args: unknown[]): Promise<OrtSession>;
}

/** 処理名: ORT runtime境界。処理概要: backend一覧取得だけを公開する。実装理由: PoTでnative API利用範囲を限定するため。 */
interface OrtRuntime {
  /** 処理名: backend一覧取得。処理概要: 同梱provider情報を返す。実装理由: session前にDMLを検証するため。 @returns backend情報。 */
  listSupportedBackends(): OrtBackend[];
  /** 処理名: session factory。処理概要: native sessionを生成する。実装理由: metadata診断wrapperを設置するため。 */
  InferenceSession: OrtSessionFactory;
}

/**
 * 処理名: DML backend判定
 * 処理概要: runtime backend情報がbundled DMLを示すか判定する。
 * 実装理由: CPU等の別providerを利用可能判定へ混ぜないため。
 * @param backend - ORT backend情報。
 * @returns bundled DMLの場合true。
 */
function isBundledDml(backend: OrtBackend): boolean {
  return backend.name === "dml" && backend.bundled;
}

/**
 * 処理名: session metadata整形
 * 処理概要: input名、tensor型、shapeだけをJSON安全な値へ変換する。
 * 実装理由: tensor値や絶対pathを診断へ含めないため。
 * @param metadata - ORT input metadata。
 * @returns 非機密input契約。
 */
function summarizeMetadata(metadata: OrtValueMetadata): Record<string, unknown> {
  return { name: metadata.name, isTensor: metadata.isTensor, type: metadata.type ?? null, shape: metadata.shape ?? null };
}

/**
 * 処理名: ORT診断runtime生成
 * 処理概要: session作成後にinput metadataだけを記録するruntime wrapperを返す。
 * 実装理由: fixed graphのdynamic dimensionを入力値なしで特定するため。
 * @param ort - 固定native ORT runtime。
 * @returns session metadata診断付きruntime。
 */
function createDiagnosticOrt(ort: OrtRuntime): OrtRuntime {
  let sessionIndex = 0;
  const factory = ort.InferenceSession;
  /**
   * 処理名: 診断付きsession生成
   * 処理概要: native session作成後にinput契約だけを出力する。
   * 実装理由: text/vision graphのsymbolic shapeを区別するため。
   * @param args - ORT session引数。
   * @returns 作成済みsession。
   */
  async function createSession(...args: unknown[]): Promise<OrtSession> {
    const sessionNumber = sessionIndex + 1;
    const sessionArgs = [...args];
    const optionsIndex = sessionArgs.length - 1;
    const options = sessionArgs[optionsIndex];
    if (typeof options !== "object" || options === null) throw new VectorError("E_INFERENCE");
    sessionArgs[optionsIndex] = { ...options, enableProfiling: true, profileFilePrefix: `.build/directml-validation/directml-profile-${sessionNumber}` };
    const session = await factory.create(...sessionArgs);
    sessionIndex += 1;
    console.log(JSON.stringify({ stage: "session-metadata", sessionIndex, inputs: session.inputMetadata.map(summarizeMetadata) }));
    let released = false;
    /** 処理名: profile付きsession解放。処理概要: profile確定後にnative sessionを一度だけ解放する。実装理由: provider証跡とclose cleanupを両立するため。 @returns 解放完了。 */
    async function releaseSession(): Promise<void> {
      if (released) return;
      released = true;
      session.endProfiling();
      await session.release();
    }
    /**
     * 処理名: session export解決
     * 処理概要: releaseだけをprofile付き処理へ置換する。
     * 実装理由: runやmetadataのnative this bindingを維持するため。
     * @param target - 元session。
     * @param property - property名。
     * @returns 元propertyまたはprofile付きrelease。
     */
    function resolveSessionExport(target: OrtSession, property: string | symbol): unknown {
      return property === "release" ? releaseSession : Reflect.get(target, property, target);
    }
    return new Proxy(session, { get: resolveSessionExport });
  }
  /**
   * 処理名: ORT export解決
   * 処理概要: session factoryだけを診断版へ置換する。
   * 実装理由: Tensor等の非enumerable native exportを元moduleから維持するため。
   * @param target - 元ORT runtime。
   * @param property - export名。
   * @param receiver - proxy receiver。
   * @returns 元exportまたは診断factory。
   */
  function resolveOrtExport(target: OrtRuntime, property: string | symbol, receiver: unknown): unknown {
    return property === "InferenceSession" ? { create: createSession } : Reflect.get(target, property, receiver);
  }
  return new Proxy(ort, { get: resolveOrtExport });
}

/**
 * 処理名: embedding BLOB検証
 * 処理概要: 768次元LE Float32のfinite値とnorm誤差を確認する。
 * 実装理由: byte数だけで壊れたGPU出力を成功扱いにしないため。
 * @param blob - engine出力。
 * @returns dimensionとnorm。
 */
function validateEmbedding(blob: Uint8Array | null): { dimension: number; norm: number } {
  if (blob === null || blob.byteLength !== 3072) throw new VectorError("E_EMBEDDING_VALUE");
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  let squaredNorm = 0;
  for (let offset = 0; offset < blob.byteLength; offset += 4) {
    const value = view.getFloat32(offset, true);
    if (!Number.isFinite(value)) throw new VectorError("E_EMBEDDING_VALUE");
    squaredNorm += value * value;
  }
  const norm = Math.sqrt(squaredNorm);
  if (Math.abs(norm - 1) > 1e-5) throw new VectorError("E_EMBEDDING_VALUE");
  return { dimension: 768, norm };
}

/**
 * 処理名: embedding cosine計算
 * 処理概要: 2つのLE Float32 BLOBをFloat64集計で比較する。
 * 実装理由: backend間のvector差を本文やvector出力なしで検証するため。
 * @param left - DirectML embedding。
 * @param right - Wasm embedding。
 * @returns cosine similarity。
 */
function embeddingCosine(left: Uint8Array, right: Uint8Array): number {
  validateEmbedding(left);
  validateEmbedding(right);
  const leftView = new DataView(left.buffer, left.byteOffset, left.byteLength);
  const rightView = new DataView(right.buffer, right.byteOffset, right.byteLength);
  let dot = 0;
  let leftSquared = 0;
  let rightSquared = 0;
  for (let offset = 0; offset < left.byteLength; offset += 4) {
    const leftValue = leftView.getFloat32(offset, true);
    const rightValue = rightView.getFloat32(offset, true);
    dot += leftValue * rightValue;
    leftSquared += leftValue * leftValue;
    rightSquared += rightValue * rightValue;
  }
  return dot / Math.sqrt(leftSquared * rightSquared);
}

/** 処理名: profile event境界。処理概要: provider集計に必要な非機密fieldだけを表す。実装理由: raw profileを成果物へ残さないため。 */
interface ProfileEvent {
  /** 処理名: event category。処理概要: node event分類を保持する。実装理由: 非node eventを除くため。 */
  cat?: unknown;
  /** 処理名: duration。処理概要: event時間をmicrosecondsで保持する。実装理由: provider累積時間を集計するため。 */
  dur?: unknown;
  /** 処理名: event引数。処理概要: provider/operatorだけを参照する。実装理由: profileの入力情報を保存しないため。 */
  args?: { provider?: unknown; op_name?: unknown };
}

type ProviderAggregate = Record<string, { nodes: number; durationUs: number }>;

/**
 * 処理名: profile event集計
 * 処理概要: 単一eventのprovider件数、時間、DML operatorを集計する。
 * 実装理由: raw event走査を低complexityの独立処理へ分けるため。
 * @param event - ORT profile event。
 * @param providers - provider別集計。
 * @param dmlOperators - DML operator集合。
 */
function collectProfileEvent(event: ProfileEvent, providers: ProviderAggregate, dmlOperators: Set<string>): void {
  const provider = event.args?.provider;
  const operator = event.args?.op_name;
  if (typeof provider !== "string") return;
  const aggregate = providers[provider] ?? { nodes: 0, durationUs: 0 };
  aggregate.nodes += 1;
  if (typeof event.dur === "number" && Number.isFinite(event.dur)) aggregate.durationUs += event.dur;
  providers[provider] = aggregate;
  if (provider === "DmlExecutionProvider" && typeof operator === "string") dmlOperators.add(operator);
}

/**
 * 処理名: profile file集計
 * 処理概要: 単一raw profileを読んで全eventを集計する。
 * 実装理由: file I/Oとevent集計を分離するため。
 * @param filename - raw profile path。
 * @param providers - provider別集計。
 * @param dmlOperators - DML operator集合。
 * @returns 集計完了。
 */
async function collectProfileFile(filename: string, providers: ProviderAggregate, dmlOperators: Set<string>): Promise<void> {
  const events = JSON.parse(await readFile(filename, "utf8")) as ProfileEvent[];
  for (const event of events) collectProfileEvent(event, providers, dmlOperators);
}

/**
 * 処理名: 主要DML operator判定
 * 処理概要: 行列積または畳込みがDML集合に存在するか確認する。
 * 実装理由: shape/control nodeだけのDML配置を合格にしないため。
 * @param operators - DML operator集合。
 * @returns 主要operatorがあればtrue。
 */
function hasMajorDmlOperator(operators: ReadonlySet<string>): boolean {
  for (const operator of operators) if (operator === "MatMul" || operator === "MatMulNBits" || operator === "Conv") return true;
  return false;
}

/**
 * 処理名: DirectML profile集計
 * 処理概要: raw profileからprovider件数、時間、主要operatorだけを集計してfileを削除する。
 * 実装理由: DML実行を証明しつつ入力や絶対pathを成果物へ残さないため。
 * @returns 非機密profile集計。
 */
async function collectProfiles(): Promise<Record<string, unknown>> {
  const directory = ".build/directml-validation";
  const names = (await readdir(directory)).filter((name) => name.startsWith("directml-profile-") && name.endsWith(".json"));
  const providers: ProviderAggregate = {};
  const dmlOperators = new Set<string>();
  try {
    for (const name of names) await collectProfileFile(`${directory}/${name}`, providers, dmlOperators);
  } finally { for (const name of names) await rm(`${directory}/${name}`, { force: true }); }
  const dml = providers.DmlExecutionProvider;
  if (names.length !== 2 || dml === undefined || dml.nodes < 1 || !hasMajorDmlOperator(dmlOperators)) throw new VectorError("E_INFERENCE");
  return { files: names.length, providers, dmlOperators: [...dmlOperators].sort() };
}

/**
 * 処理名: DirectML PoT report保存
 * 処理概要: 非機密集計をstage fileへ書いてから原子的に置換する。
 * 実装理由: 失敗時に過去の完了reportを部分JSONで破壊しないため。
 * @param report - 入力/vector/pathを含まない成功report。
 */
async function writeReport(report: Record<string, unknown>): Promise<void> {
  const directory = "artifacts/release-gates";
  const stage = `${directory}/directml-report.json.stage`;
  const target = `${directory}/directml-report.json`;
  await mkdir(directory, { recursive: true });
  await rm(stage, { force: true });
  await writeFile(stage, JSON.stringify(report, null, 2) + "\n", "utf8");
  await rename(stage, target);
}

/**
 * 処理名: portable画像module解決
 * 処理概要: 上流画像I/Oを固定codec adapterへ置換する。
 * 実装理由: sharp等のnative画像依存をDirectML PoTへ混ぜないため。
 * @param args - import解決条件。
 * @returns 置換対象だけの解決結果。
 */
function resolvePortableImage(args: OnResolveArgs): OnResolveResult | undefined {
  return resolve(args.resolveDir, args.path) === resolve(upstreamRoot, "src/utils/image.js") ? { path: resolve("src/inference/image.ts") } : undefined;
}

/**
 * 処理名: portable画像plugin設定
 * 処理概要: 上流画像moduleだけを製品codecへ解決する。
 * 実装理由: resolverの対象を単一moduleへ限定するため。
 * @param plugin - esbuild plugin API。
 */
function setupPortableImage(plugin: import("esbuild").PluginBuild): void {
  plugin.onResolve({ filter: /image\.js$/ }, resolvePortableImage);
}

/**
 * 処理名: DirectML上流準備
 * 処理概要: 固定Transformers tarballを独立展開しDirectML限定patchを適用する。
 * 実装理由: portable patch済みtreeや未固定node_modulesを実証根拠にしないため。
 */
async function prepareUpstream(): Promise<void> {
  await rm(".build/directml-validation", { recursive: true, force: true });
  await mkdir(upstreamRoot, { recursive: true });
  const nodeModulesPkg = resolve("node_modules/@huggingface/transformers");
  if (!existsSync(nodeModulesPkg)) {
    throw new Error("TRANSFORMERS_UPSTREAM_MISSING");
  }
  cpSync(nodeModulesPkg, upstreamRoot, { recursive: true });
  execFileSync("git", ["apply", "--unidiff-zero", "--ignore-space-change", "--ignore-whitespace", `--directory=${upstreamPatchRoot}`, "patches/transformers-directml.patch"], { stdio: "inherit" });
}

/**
 * 処理名: DirectML bundle生成
 * 処理概要: 固定上流とonnxruntime-nodeだけを使うprivate runtimeを生成する。
 * 実装理由: PoTでも製品予定のbundle境界を検証するため。
 */
async function buildRuntime(): Promise<void> {
  const entry = [
    `export {env} from "./${upstreamPatchRoot}/src/env.js";`,
    `export {AutoConfig} from "./${upstreamPatchRoot}/src/configs.js";`,
    `export {AutoModel} from "./${upstreamPatchRoot}/src/models/auto/modeling_auto.js";`,
    `export {AutoProcessor} from "./${upstreamPatchRoot}/src/models/auto/processing_auto.js";`,
    'export {decodeRawImage} from "./src/inference/image.ts";',
    'export {initializeImageCodecs} from "./src/inference/image-codecs.ts";'
  ].join("\n");
  try {
    await build({
      stdin: { contents: entry, resolveDir: process.cwd(), loader: "ts" },
      outfile: outputFile,
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node24",
      external: ["onnxruntime-node"],
      define: { "import.meta": "__svw_import_meta" },
      banner: { js: "const __svw_import_meta = {url: require('node:url').pathToFileURL(__filename).href};" },
      plugins: [{ name: "portable-image", setup: setupPortableImage }]
    });
  } finally { await rm(upstreamRoot, { recursive: true, force: true }); }
}

/**
 * 処理名: 固定model cache生成
 * 処理概要: manifest pathを固定revisionのlocal bytesへ対応付ける。
 * 実装理由: 任意pathや未検証資材をnative loaderへ渡さないため。
 * @returns hash検証付きcache。
 */
async function createVerifiedCache(): Promise<VerifiedModelCache> {
  const manifest = JSON.parse(await readFile("manifests/embeddinggemma2-q4.json", "utf8")) as { assets: ModelAssetDigest[] };
  /**
   * 処理名: 固定model資材読取り
   * 処理概要: manifest pathを固定revisionのsource名へ対応付ける。
   * 実装理由: cacheへ任意path readerを渡さないため。
   * @param path - manifest内の論理path。
   * @returns 固定資材bytesまたは未対応。
   */
  async function readModelAsset(path: string): Promise<Uint8Array | undefined> {
    for (const definition of MODEL_ASSET_FILES) {
      if (definition.path === path) return readFile(resolve(modelRoot, definition.source));
    }
    return undefined;
  }
  return new VerifiedModelCache(manifest.assets, readModelAsset);
}

/**
 * 処理名: DirectML model cache生成
 * 処理概要: 元資材検証後にvision graphだけをメモリ内patchするcacheを返す。
 * 実装理由: Wasm参照cacheと元bytes契約を共有するため。
 * @returns DirectML専用cache。
 */
async function createDirectMlCache(): Promise<DirectMlModelCache> {
  return new DirectMlModelCache(await createVerifiedCache());
}

/**
 * 処理名: codec資材読取り
 * 処理概要: 固定JPEG/PNG/resize Wasm bytesを返す。
 * 実装理由: DirectMLとWasmで同じ画像前処理を使用するため。
 * @returns 固定codec bytes。
 */
async function readCodecs(): Promise<ImageCodecBytes> {
  return {
    jpeg: await readFile("node_modules/@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm"),
    png: await readFile("node_modules/@jsquash/png/codec/pkg/squoosh_png_bg.wasm"),
    resize: await readFile("node_modules/@jsquash/resize/lib/resize/pkg/squoosh_resize_bg.wasm")
  };
}

/**
 * 処理名: Wasm parity検証
 * 処理概要: 同一入力を既存Wasm runtimeで実行しDirectML embeddingとのcosineを検証する。
 * 実装理由: vision graph互換patchが公開vector契約を変えないことを確認するため。
 * @param directMl - modality別DirectML embedding。
 * @param codecs - 共通画像codec bytes。
 * @returns modality別cosine。
 */
async function verifyWasmParity(directMl: ReadonlyMap<string, Uint8Array>, codecs: ImageCodecBytes): Promise<Record<string, number>> {
  const runtime = require(resolve("dist/vendor/transformers-portable-node.js")) as PortableRuntime;
  const engine = await initializeInferenceEngine(runtime, {
    backend: "wasm",
    cache: await createVerifiedCache(),
    wasmUrl: pathToFileURL(resolve("dist/ort/ort-wasm-simd-threaded.jsep.wasm")).href,
    factoryUrl: pathToFileURL(resolve("dist/ort/ort-wasm-simd-threaded.jsep.mjs")).href,
    codecs,
    warmupImage: warmupImageBytes()
  });
  const scores: Record<string, number> = {};
  try {
    const embeddings = new Map<string, Uint8Array | null>();
    embeddings.set("query", await engine.embed({ operation: "query", body: "DirectML verification" }));
    embeddings.set("document", await engine.embed({ operation: "document", title: "DirectML", body: "GPU vector search" }));
    embeddings.set("image", await engine.embed({ operation: "image", bytes: warmupImageBytes(), mime: "image/png" }));
    for (const [operation, wasm] of embeddings) {
      const candidate = directMl.get(operation);
      if (candidate === undefined || wasm === null) throw new VectorError("E_EMBEDDING_VALUE");
      const score = embeddingCosine(candidate, wasm);
      if (!Number.isFinite(score) || score < 0.999) throw new VectorError("E_EMBEDDING_VALUE");
      scores[operation] = score;
    }
  } finally { await engine.close(); }
  return scores;
}

/**
 * 処理名: DirectML実model probe
 * 処理概要: DML backend確認後に固定bytesからquery/image sessionをwarm-upする。
 * 実装理由: 製品実装前にexternal dataを含む実graphの成立を反証可能にするため。
 */
async function probe(): Promise<void> {
  probeStage = "environment";
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("E_ENVIRONMENT");
  const ort = require("onnxruntime-node") as OrtRuntime;
  if (!ort.listSupportedBackends().some(isBundledDml)) throw new Error("E_ENVIRONMENT");
  const runtimeSymbol = Symbol.for("onnxruntime");
  const runtimeGlobal = globalThis as typeof globalThis & Record<symbol, unknown>;
  runtimeGlobal[runtimeSymbol] = createDiagnosticOrt(ort);
  probeStage = "upstream";
  await prepareUpstream();
  try {
    probeStage = "bundle";
    await buildRuntime();
    probeStage = "bundle-load";
    const runtime = require(outputFile) as PortableRuntime;
    probeStage = "engine-initialize";
    const cache = await createDirectMlCache();
    const codecs = await readCodecs();
    const engine = await initializeInferenceEngine(runtime, {
      backend: "directml",
      graphOptimizationLevel: "disabled",
      cache,
      codecs,
      warmupImage: warmupImageBytes()
    });
    const graphPatch = cache.patchInfo();
    console.log(JSON.stringify({ stage: "vision-graph-patch", ...graphPatch, status: "passed" }));
    const operations: Array<{ operation: string; bytes: number; dimension: number; norm: number }> = [];
    const directMlEmbeddings = new Map<string, Uint8Array>();
    try {
      probeStage = "query";
      const query = await engine.embed({ operation: "query", body: "DirectML verification" });
      operations.push({ operation: "query", bytes: query?.byteLength ?? 0, ...validateEmbedding(query) });
      if (query !== null) directMlEmbeddings.set("query", query);
      probeStage = "document";
      const document = await engine.embed({ operation: "document", title: "DirectML", body: "GPU vector search" });
      operations.push({ operation: "document", bytes: document?.byteLength ?? 0, ...validateEmbedding(document) });
      if (document !== null) directMlEmbeddings.set("document", document);
      probeStage = "image";
      const image = await engine.embed({ operation: "image", bytes: warmupImageBytes(), mime: "image/png" });
      operations.push({ operation: "image", bytes: image?.byteLength ?? 0, ...validateEmbedding(image) });
      if (image !== null) directMlEmbeddings.set("image", image);
      probeStage = "repeat-query";
      for (let index = 0; index < 100; index += 1) validateEmbedding(await engine.embed({ operation: "query", body: `DirectML verification ${index}` }));
    } finally { await engine.close(); }
    probeStage = "profile";
    const profile = await collectProfiles();
    delete runtimeGlobal[runtimeSymbol];
    probeStage = "wasm-parity";
    const wasmCosine = await verifyWasmParity(directMlEmbeddings, codecs);
    const manifest = JSON.parse(await readFile("manifests/embeddinggemma2-q4.json", "utf8")) as { fingerprint: string };
    const report = {
      stage: "node-directml",
      status: "passed",
      environment: { platform: process.platform, architecture: process.arch, node: process.version },
      runtime: { name: "onnxruntime-node", version: "1.31.1", executionProvider: "dml" },
      modelFingerprint: manifest.fingerprint,
      graphPatch,
      operations,
      repeatedQueries: 100,
      profile,
      wasmCosine
    };
    await writeReport(report);
    console.log(JSON.stringify(report));
  } finally { delete runtimeGlobal[runtimeSymbol]; await rm(outputFile, { force: true }); }
}

probe().catch(() => { console.error(JSON.stringify({ stage: probeStage, code: "E_INFERENCE", status: "failed" })); process.exitCode = 1; });