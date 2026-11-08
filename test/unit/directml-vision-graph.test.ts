import { readFile } from "node:fs/promises";
import { patchDirectMlVisionGraph } from "../../src/inference/backends/directml-vision-graph";

const graphPath = "model/embeddinggemma-2-ONNX/daa72c51243991dfcaf9f9137d2c573d8f7790c0/vision_encoder_q4.onnx";

/**
 * 処理名: DirectML vision graph patch検証
 * 処理概要: 固定元graphから128箇所だけを変更した固定bytesを生成する。
 * 実装理由: DML Reshape互換修正を未検証graphへ適用しないため。
 * @returns 検証完了。
 */
async function verifyVisionGraphPatch(): Promise<void> {
  const result = patchDirectMlVisionGraph(await readFile(graphPath));
  expect(result.changed).toBe(128);
  expect(result.bytes).toHaveLength(159391);
  expect(result.sha256).toBe("e6115d00cb043a16d22376e513898471a911cd97d42832871f92599fd4279fe4");
  expect(() => patchDirectMlVisionGraph(result.bytes)).toThrow("E_ASSET_INTEGRITY");
  expect(() => patchDirectMlVisionGraph(new Uint8Array([1, 2, 3]))).toThrow("E_ASSET_INTEGRITY");
}

/**
 * 処理名: DirectML PoT report検証
 * 処理概要: modality、反復、provider、parity、redactionの完了証跡を確認する。
 * 実装理由: 部分PoTや入力を含むreportを完走根拠にしないため。
 * @returns 検証完了。
 */
async function verifyDirectMlReport(): Promise<void> {
  const reportText = await readFile("artifacts/release-gates/directml-report.json", "utf8");
  const report = JSON.parse(reportText) as {
    status: string;
    graphPatch: { changed: number; bytes: number; sha256: string };
    operations: Array<{ operation: string; bytes: number; dimension: number; norm: number }>;
    repeatedQueries: number;
    profile: { providers: Record<string, { nodes: number }>; dmlOperators: string[] };
    wasmCosine: Record<string, number>;
  };
  expect(report.status).toBe("passed");
  expect(report.graphPatch).toEqual({ changed: 128, bytes: 159391, sha256: "e6115d00cb043a16d22376e513898471a911cd97d42832871f92599fd4279fe4" });
  expect(report.operations.map((operation) => operation.operation)).toEqual(["query", "document", "image"]);
  for (const operation of report.operations) {
    expect(operation).toEqual(expect.objectContaining({ bytes: 3072, dimension: 768 }));
    expect(Math.abs(operation.norm - 1)).toBeLessThanOrEqual(1e-5);
  }
  expect(report.repeatedQueries).toBe(100);
  expect(report.profile.providers.DmlExecutionProvider?.nodes).toBeGreaterThan(0);
  expect(report.profile.dmlOperators).toEqual(expect.arrayContaining(["MatMul", "MatMulNBits"]));
  expect(Object.values(report.wasmCosine)).toHaveLength(3);
  for (const cosine of Object.values(report.wasmCosine)) expect(cosine).toBeGreaterThanOrEqual(0.999);
  expect(reportText).not.toMatch(/authorization|token|pixel_values|input_ids|[A-Za-z]:\\/i);
}

test("PoT-DML-01: vision graph compatibility patch is deterministic", verifyVisionGraphPatch);
test("PoT-DML-02: report proves DML execution and Wasm parity", verifyDirectMlReport);