import { InferenceEngine, type PortableRuntime, type RuntimeModel, type RuntimeProcessor } from "../../src/inference/engine";

/**
 * 処理名: 推論境界fixture
 * 処理概要: 外部runtimeの呼出しとdisposeをJestで観測する。
 * 実装理由: 実モデルなしで入力・資源解放・失敗伝播を検証するため。
 * @returns engineと観測用mock。
 */
function engineFixture() {
  const inputDispose = jest.fn();
  const outputDispose = jest.fn();
  const modelDispose = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
  const processor = Object.assign(jest.fn().mockResolvedValue({ input_ids: { data: new BigInt64Array([2n, 3n]), dims: [1, 2], dispose: inputDispose } }), { tokenizer: { all_special_tokens: ["<|image|>"] } });
  const model = Object.assign(jest.fn().mockResolvedValue({ sentence_embedding: { data: new Float32Array(768).fill(1), dims: [1, 768], dispose: outputDispose } }), { dispose: modelDispose });
  const runtime = {
    env: { backends: { onnx: { wasm: {} } } },
    AutoConfig: { from_pretrained: jest.fn().mockResolvedValue({ audio_config: {}, vision_config: {} }) },
    AutoProcessor: { from_pretrained: jest.fn().mockResolvedValue(processor) },
    AutoModel: { from_pretrained: jest.fn().mockResolvedValue(model) },
    initializeImageCodecs: jest.fn().mockResolvedValue(undefined),
    decodeRawImage: jest.fn().mockResolvedValue({ image: true })
  } as unknown as PortableRuntime;
  const engine = new InferenceEngine(runtime);
  engine.attach(processor as unknown as RuntimeProcessor, model as unknown as RuntimeModel);
  return { engine, processor, model, inputDispose, outputDispose, modelDispose, runtime };
}

/**
 * 処理名: taskと解放の検証
 * 処理概要: query prefixと768次元出力、tensor disposeを確認する。
 * 実装理由: 入力意味を維持し中間tensorを保持しないため。
 * @returns 検証完了。
 */
async function verifyEngineInference(): Promise<void> {
  const fixture = engineFixture();
  const result = await fixture.engine.embed({ operation: "query", body: "query" });
  expect(fixture.processor).toHaveBeenCalledWith("task: search result | query: query", null);
  expect(result?.length).toBe(3072);
  expect(fixture.inputDispose).toHaveBeenCalledTimes(1);
  expect(fixture.outputDispose).toHaveBeenCalledTimes(1);
  await fixture.engine.close();
  await fixture.engine.close();
  expect(fixture.modelDispose).toHaveBeenCalledTimes(1);
}

/**
 * 処理名: NULLと不正入力の検証
 * 処理概要: NULLで推論せずspecial tokenをprocessor前に拒否する。
 * 実装理由: 不要な外部runtime呼出しを防ぐため。
 * @returns 検証完了。
 */
async function verifyEngineInputs(): Promise<void> {
  const fixture = engineFixture();
  expect(await fixture.engine.embed({ operation: "document", body: null })).toBeNull();
  await expect(fixture.engine.embed({ operation: "query", body: "<|image|>" })).rejects.toThrow("E_INPUT");
  expect(fixture.processor).not.toHaveBeenCalled();
  await fixture.engine.close();
}

/**
 * 処理名: 推論失敗後の解放
 * 処理概要: modelが失敗してもinputsをdisposeし次の処理を可能にする。
 * 実装理由: rejected Promiseやtensorを後続jobへ引き継がないため。
 * @returns 検証完了。
 */
async function verifyEngineFailure(): Promise<void> {
  const fixture = engineFixture();
  fixture.model.mockRejectedValueOnce(new Error("private model error"));
  await expect(fixture.engine.embed({ operation: "query", body: "query" })).rejects.toThrow("E_INFERENCE");
  expect(fixture.inputDispose).toHaveBeenCalledTimes(1);
  expect(await fixture.engine.embed({ operation: "query", body: "query" })).toHaveLength(3072);
  await fixture.engine.close();
}

/**
 * 処理名: token制限時の解放
 * 処理概要: 最終token上限を超えた入力を推論前に破棄する。
 * 実装理由: prefix込み制限を守り失敗時にもtensorを解放するため。
 * @returns 検証完了。
 */
async function verifyEngineTokens(): Promise<void> {
  const fixture = engineFixture();
  fixture.processor.mockResolvedValueOnce({ input_ids: { data: new BigInt64Array(2049), dims: [1, 2049], dispose: fixture.inputDispose } });
  await expect(fixture.engine.embed({ operation: "query", body: "query" })).rejects.toThrow("E_TOKEN_LIMIT");
  expect(fixture.model).not.toHaveBeenCalled();
  expect(fixture.inputDispose).toHaveBeenCalledTimes(1);
  await fixture.engine.close();
}

test("R03: prefix, normalized output and lifecycle", verifyEngineInference);
test("R03: NULL and special token short-circuit", verifyEngineInputs);
test("R10: failure cleanup and next request", verifyEngineFailure);
test("R03: final token limit before model run", verifyEngineTokens);

test("v0.0.3: image errors crossing a runtime bundle retain their nonfatal code", async () => {
  const fixture = engineFixture();
  jest.mocked(fixture.runtime.decodeRawImage).mockRejectedValueOnce(Object.assign(new Error("private decoder detail"), { code: "E_IMAGE_FORMAT" }));
  await expect(fixture.engine.embed({ operation: "image", bytes: Uint8Array.of(0), mime: "image/png" })).rejects.toThrow("E_IMAGE_FORMAT");
  expect(fixture.model).not.toHaveBeenCalled();
  expect(await fixture.engine.embed({ operation: "query", body: "query" })).toHaveLength(3072);
  await fixture.engine.close();
});

/**
 * 処理名: 異常モデル出力の拒否
 * 処理概要: sentence_embedding欠落や非FP32値を致命的出力エラーにする。
 * 実装理由: shape検証前のTypeErrorへ異常出力を紛れ込ませないため。
 * @param output - 不正なmodel出力。
 * @returns 検証完了。
 */
async function verifyInvalidModelOutput(output: Record<string, unknown>): Promise<void> {
  const fixture = engineFixture();
  fixture.model.mockResolvedValueOnce(output);
  await expect(fixture.engine.embed({ operation: "query", body: "query" })).rejects.toThrow("E_EMBEDDING_VALUE");
  expect(fixture.inputDispose).toHaveBeenCalledTimes(1);
  await fixture.engine.close();
}

test.each([{}, { sentence_embedding: null }, { sentence_embedding: { data: null, dims: [1, 768] } }, { sentence_embedding: { data: new Uint16Array(768), dims: [1, 768] } }])("R03/R10: invalid model output %#", verifyInvalidModelOutput);