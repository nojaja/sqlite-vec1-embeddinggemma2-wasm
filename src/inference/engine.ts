import { VectorError, type ErrorCode } from "../errors";
import { assertTokenLimit, embeddingToBlob, formatTextInput } from "./profile";

/** runtimeへ渡す入力(任意tensor項目とinput_ids)。 */
export interface RuntimeInputs { input_ids: { data: ArrayLike<number | bigint>; dims: readonly number[] }; [key: string]: unknown }
/** processor呼出し型。 */
export type RuntimeProcessor = ((text: string | null, image: unknown) => Promise<RuntimeInputs>) & { tokenizer: { all_special_tokens: readonly string[] } };
/** model呼出し型。 */
export type RuntimeModel = ((inputs: RuntimeInputs) => Promise<Record<string, unknown>>) & { dispose(): Promise<void> };

/** 外部Transformers.js/ORT境界。 */
export interface PortableRuntime {
  env: { backends: { onnx: { wasm?: Record<string, unknown>; [key: string]: unknown } }; [key: string]: unknown };
  AutoConfig: { from_pretrained(id: string, options?: Record<string, unknown>): Promise<Record<string, unknown>> };
  AutoProcessor: { from_pretrained(id: string, options?: Record<string, unknown>): Promise<RuntimeProcessor> };
  AutoModel: { from_pretrained(id: string, options?: Record<string, unknown>): Promise<RuntimeModel> };
  initializeImageCodecs(assets: { jpeg: Uint8Array; png: Uint8Array; resize: Uint8Array }): Promise<void>;
  decodeRawImage(bytes: Uint8Array, mime: string): Promise<unknown>;
}

/** 推論要求。 */
export type EmbedRequest =
  | { operation: "query" | "document"; body: unknown; title?: unknown }
  | { operation: "image"; bytes: unknown; mime: unknown };

/**
 * 処理名: dispose可能object収集
 * 処理概要: 入出力のdispose持ちobjectをidentity重複なしで集める。
 * 実装理由: 同一tensorの二重disposeを避けるため。
 * @param values - 検査対象record。
 * @param target - 収集先。
 */
function collectDisposables(values: unknown, target: Set<{ dispose(): unknown }>): void {
  if (typeof values !== "object" || values === null) return;
  for (const value of Object.values(values)) {
    if (typeof value === "object" && value !== null && typeof (value as { dispose?: unknown }).dispose === "function") target.add(value as { dispose(): unknown });
  }
}

/**
 * 処理名: 例外正規化
 * 処理概要: 既知VectorErrorは保持、画像codeのみ許可、他はE_INFERENCEへ変換する。
 * 実装理由: 外部例外本文を漏らさないため。
 * @param error - 捕捉した例外。
 * @returns 製品エラー。
 */
function normalizeError(error: unknown): VectorError {
  if (error instanceof VectorError) return error;
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  if (code === "E_IMAGE_FORMAT" || code === "E_IMAGE_LIMIT") return new VectorError(code as ErrorCode);
  return new VectorError("E_INFERENCE");
}

/**
 * 処理名: 推論engine
 * 処理概要: processor/modelを一度だけ受け取り、768次元BLOBを生成する。
 * 実装理由: 入力検証・資源解放・失敗伝播を一箇所で保証するため。
 */
export class InferenceEngine {
  private processor: RuntimeProcessor | undefined;
  private model: RuntimeModel | undefined;
  private attached = false;
  private closed = false;
  private readonly runtime: PortableRuntime;

  /**
   * 処理名: engine生成
   * 処理概要: runtime境界を保持する。
   * 実装理由: globalへ漏らさずmockを渡せるようにするため。
   * @param runtime - 外部runtime。
   */
  public constructor(runtime: PortableRuntime) { this.runtime = runtime; }

  /**
   * 処理名: processor/model接続
   * 処理概要: 一度だけprocessorとmodelを設定する。
   * 実装理由: 二重attachやclose後の再利用を防ぐため。
   * @param processor - processor。
   * @param model - model。
   */
  public attach(processor: RuntimeProcessor, model: RuntimeModel): void {
    if (this.attached || this.closed) throw new VectorError("E_ENVIRONMENT");
    this.processor = processor;
    this.model = model;
    this.attached = true;
  }

  /**
   * 処理名: embedding生成
   * 処理概要: 入力検証、processor、token検証、model実行、BLOB変換を行う。
   * 実装理由: NULL短絡と全tensor解放を保証するため。
   * @param request - 推論要求。
   * @returns BLOBまたはNULL。
   */
  public async embed(request: EmbedRequest): Promise<Uint8Array | null> {
    const processor = this.processor;
    const model = this.model;
    if (!this.attached || this.closed || processor === undefined || model === undefined) throw new VectorError("E_ENVIRONMENT");
    const disposables = new Set<{ dispose(): unknown }>();
    try {
      let inputs: RuntimeInputs;
      if (request.operation === "image") {
        if (request.bytes === null || request.bytes === undefined) return null;
        if (typeof request.mime !== "string") throw new VectorError("E_INPUT");
        const image = await this.runtime.decodeRawImage(request.bytes as Uint8Array, request.mime);
        inputs = await processor(null, image);
      } else {
        const text = formatTextInput(request.operation, request.body, request.title, processor.tokenizer.all_special_tokens);
        if (text === null) return null;
        inputs = await processor(text, null);
      }
      collectDisposables(inputs, disposables);
      assertTokenLimit(inputs.input_ids.data.length);
      const outputs = await model(inputs);
      collectDisposables(outputs, disposables);
      return this.toBlob(outputs);
    } catch (error) {
      throw normalizeError(error);
    } finally {
      for (const item of disposables) await Promise.resolve(item.dispose()).catch(() => undefined);
    }
  }

  /**
   * 処理名: 出力変換
   * 処理概要: sentence_embeddingのFloat32 dataとdimsを検証してBLOB化する。
   * 実装理由: 異常出力を致命的出力エラーに統一するため。
   * @param outputs - model出力。
   * @returns BLOB。
   */
  private toBlob(outputs: Record<string, unknown>): Uint8Array {
    const tensor = outputs.sentence_embedding as { data?: unknown; dims?: unknown } | null | undefined;
    if (typeof tensor !== "object" || tensor === null || !(tensor.data instanceof Float32Array) || !Array.isArray(tensor.dims)) throw new VectorError("E_EMBEDDING_VALUE");
    return embeddingToBlob(tensor.data, tensor.dims as number[]);
  }

  /**
   * 処理名: engine終了
   * 処理概要: modelを一度だけdisposeし参照を外す。再closeは成功する。
   * 実装理由: GPU/Wasm資源を確実に解放するため。
   */
  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const model = this.model;
    this.model = undefined;
    this.processor = undefined;
    if (model !== undefined) await model.dispose();
  }
}
