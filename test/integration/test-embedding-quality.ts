import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { evaluateEmbeddingQuality, type EmbeddingQualityPair } from "../../src/inference/embedding-quality";
import { EMBEDDING_BYTES, EMBEDDING_DIMENSION } from "../../src/inference/profile";

const qualityRoot = resolve("fixtures", "embedding-quality");
const qualityManifestPath = resolve(qualityRoot, "manifest.json");
const qualityReportPath = "artifacts/release-gates/embedding-quality.json";
const qualityBlockerPath = "artifacts/release-gates/embedding-quality-blocker.json";

/**
 * 処理名: G03参照定義
 * 処理概要: モデル参照と変換参照の固定版・精度・toolを表す。
 * 実装理由: 可変modelや不明な生成環境のvectorをgoldenへ混ぜないため。
 */
interface QualityReferenceDefinition {
  modelId: string;
  revision: string;
  precision: "fp32" | "bf16";
  tool: string;
  toolVersion: string;
}

/**
 * 処理名: G03 fixture定義
 * 処理概要: 一入力のq4・変換・モデル参照vector pathと画像metadataを表す。
 * 実装理由: 同じfixture IDの三出力を決定的に比較するため。
 */
interface QualityFixtureDefinition {
  id: string;
  modality: "text" | "image";
  q4Vector: string;
  conversionVector: string;
  modelReferenceVector: string;
  source?: string;
  license?: string;
  sha256?: string;
}

/**
 * 処理名: G03 manifest
 * 処理概要: 固定参照環境と全fixtureを保持する。
 * 実装理由: 100 text/32 imageの入力・出力対応を機械検証するため。
 */
interface QualityManifest {
  schemaVersion: 1;
  modelReference: QualityReferenceDefinition;
  conversionReference: QualityReferenceDefinition;
  fixtures: QualityFixtureDefinition[];
}

/**
 * 処理名: G03参照metadata検証
 * 処理概要: モデル参照と変換参照の精度・固定識別子を確認する。
 * 実装理由: q4や空のtool情報をgolden参照として採用しないため。
 * @param manifest - 未検証manifest。
 */
function validateQualityReferences(manifest: QualityManifest): void {
  const modelPrecision = new Set(["fp32", "bf16"]);
  if (!modelPrecision.has(manifest.modelReference.precision) || manifest.conversionReference.precision !== "fp32") throw new Error("QUALITY_MANIFEST_INVALID");
  for (const reference of [manifest.modelReference, manifest.conversionReference]) {
    if (reference.modelId.length === 0 || !/^[a-f0-9]{40}$/.test(reference.revision) || reference.tool.length === 0 || reference.toolVersion.length === 0) throw new Error("QUALITY_MANIFEST_INVALID");
  }
}

/**
 * 処理名: G03 fixture件数検証
 * 処理概要: modality件数を集計し画像の出典・license・hashを確認する。
 * 実装理由: 不足fixtureや再配布根拠のない画像をgateへ入れないため。
 * @param fixtures - 未検証fixture一覧。
 * @returns text/image件数。
 */
function countQualityFixtures(fixtures: readonly QualityFixtureDefinition[]): { text: number; image: number } {
  let text = 0;
  let image = 0;
  for (const fixture of fixtures) {
    if (fixture.modality === "text") text += 1;
    else {
      image += 1;
      if (fixture.source === undefined || fixture.license === undefined || !/^[a-f0-9]{64}$/.test(fixture.sha256 ?? "")) throw new Error("QUALITY_MANIFEST_INVALID");
    }
  }
  return { text, image };
}

/**
 * 処理名: G03 atomic JSON保存
 * 処理概要: stage fileをfsync可能な同directoryで最終pathへ置換する。
 * 実装理由: 中断時の部分reportを成功証跡として残さないため。
 * @param filename - 最終report path。
 * @param value - JSON化するreport。
 */
async function writeQualityReport(filename: string, value: unknown): Promise<void> {
  await mkdir(dirname(filename), { recursive: true });
  const stage = `${filename}.stage`;
  await writeFile(stage, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(stage, filename);
}

/**
 * 処理名: G03 manifest検証
 * 処理概要: schema、参照精度、件数、画像出典metadataを確認する。
 * 実装理由: 不完全fixtureやq4を参照値として使うmanifestを拒否するため。
 * @param manifest - 未検証manifest。
 */
function validateQualityManifest(manifest: QualityManifest): void {
  if (manifest.schemaVersion !== 1) throw new Error("QUALITY_MANIFEST_INVALID");
  validateQualityReferences(manifest);
  const counts = countQualityFixtures(manifest.fixtures);
  if (counts.text < 100 || counts.image < 32) throw new Error("QUALITY_FIXTURE_COUNT");
}

/**
 * 処理名: G03 vector path解決
 * 処理概要: fixture root内の通常fileだけをcanonical pathへ解決する。
 * 実装理由: traversalやsymlinkで任意fileをgolden vectorとして読まないため。
 * @param relative - manifest相対path。
 * @returns 検証済みfile path。
 */
async function resolveQualityVector(relative: string): Promise<string> {
  if (!/^[a-zA-Z0-9_./-]+$/.test(relative) || relative.includes("..")) throw new Error("QUALITY_PATH_INVALID");
  const filename = resolve(qualityRoot, relative);
  const root = `${await realpath(qualityRoot)}${sep}`;
  const canonical = await realpath(filename);
  const metadata = await lstat(filename);
  if (!canonical.startsWith(root) || !metadata.isFile() || metadata.isSymbolicLink()) throw new Error("QUALITY_PATH_INVALID");
  return canonical;
}

/**
 * 処理名: G03 LE vector読込み
 * 処理概要: 3072-byte fileを明示little-endian Float32Arrayへ変換する。
 * 実装理由: host endiannessやBufferの共有範囲に依存しないため。
 * @param relative - fixture rootからのvector path。
 * @returns 独立した768次元vector。
 */
async function readQualityVector(relative: string): Promise<Float32Array> {
  const bytes = await readFile(await resolveQualityVector(relative));
  if (bytes.byteLength !== EMBEDDING_BYTES) throw new Error("QUALITY_VECTOR_SIZE");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result = new Float32Array(EMBEDDING_DIMENSION);
  for (let index = 0; index < EMBEDDING_DIMENSION; index += 1) result[index] = view.getFloat32(index * 4, true);
  return result;
}

/**
 * 処理名: G03比較pair構築
 * 処理概要: manifest fixtureからq4/変換/モデル参照の二比較集合を作る。
 * 実装理由: 同じ入力集合で変換誤差と量子化誤差を分離するため。
 * @param fixtures - 検証済みfixture定義。
 * @returns モデル対変換とq4対変換のpair集合。
 */
async function buildQualityPairs(fixtures: readonly QualityFixtureDefinition[]): Promise<{ model: EmbeddingQualityPair[]; q4: EmbeddingQualityPair[] }> {
  const model: EmbeddingQualityPair[] = [];
  const q4: EmbeddingQualityPair[] = [];
  for (const fixture of fixtures) {
    const [modelReference, conversion, quantized] = await Promise.all([
      readQualityVector(fixture.modelReferenceVector),
      readQualityVector(fixture.conversionVector),
      readQualityVector(fixture.q4Vector)
    ]);
    model.push({ id: fixture.id, modality: fixture.modality, candidate: conversion, reference: modelReference });
    q4.push({ id: fixture.id, modality: fixture.modality, candidate: quantized, reference: conversion });
  }
  return { model, q4 };
}

/**
 * 処理名: G03 embedding品質gate
 * 処理概要: 固定manifest/vectorを読み二系列のcosine基準を評価する。
 * 実装理由: mockや事前合格reportでG03を通さず実参照bytesを毎回検証するため。
 */
async function testEmbeddingQuality(): Promise<void> {
  const manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readFile(qualityManifestPath))) as QualityManifest;
  validateQualityManifest(manifest);
  const pairs = await buildQualityPairs(manifest.fixtures);
  const modelVsConversion = evaluateEmbeddingQuality(pairs.model, { text: { mean: 0.99, each: 0.98 }, image: { mean: 0.99, each: 0.98 } });
  const q4VsConversion = evaluateEmbeddingQuality(pairs.q4, { text: { mean: 0.98, each: 0.9 }, image: { mean: 0.96, each: 0.9 } });
  const report = { stage: "embedding-quality", status: modelVsConversion.passed && q4VsConversion.passed ? "passed" : "failed", modelReference: manifest.modelReference, conversionReference: manifest.conversionReference, modelVsConversion, q4VsConversion };
  await writeQualityReport(qualityReportPath, report);
  await rm(qualityBlockerPath, { force: true });
  console.log(JSON.stringify({ stage: report.stage, status: report.status, fixtures: manifest.fixtures.length }));
  if (report.status !== "passed") throw new Error("QUALITY_THRESHOLD_FAILED");
}

/**
 * 処理名: G03 blocker記録
 * 処理概要: 入力pathや例外本文を出さず不足条件をJSONへ保存する。
 * 実装理由: 参照資材不足を0件成功や過去reportで隠さないため。
 */
async function reportQualityBlocker(): Promise<void> {
  const blocker = {
    stage: "embedding-quality",
    status: "blocked",
    reason: "REFERENCE_FIXTURES_UNAVAILABLE",
    required: {
      textFixtures: 100,
      imageFixtures: 32,
      modelReferencePrecision: ["fp32", "bf16"],
      conversionReferencePrecision: "fp32",
      q4Outputs: true,
      onnxReferenceBytes: 1755739090,
      originalReferenceBytes: 1521095085,
      pythonPackages: ["torch", "transformers", "sentence-transformers", "safetensors", "Pillow"],
      fixedWheelhouse: true
    }
  };
  await writeQualityReport(qualityBlockerPath, blocker);
  console.error(JSON.stringify({ stage: blocker.stage, status: blocker.status, reason: blocker.reason }));
  process.exitCode = 1;
}

testEmbeddingQuality().catch(reportQualityBlocker);