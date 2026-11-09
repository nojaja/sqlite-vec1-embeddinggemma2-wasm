import { VectorError, type ErrorCode } from "../errors";
import { assertTokenLimit, embeddingToBlob, formatTextInput } from "./profile";
import type { ImageCodecBytes } from "./image-codecs";

/**
 * 処理名: 破棄可能リソースインターフェース
 * 処理概要: disposeメソッドを持つオブジェクトの型を定義する。
 * 実装理由: 使用済みテンソルリソースを安全に破棄するため。
 */
export interface DisposableResource {
  /**
   * 処理名: リソース破棄
   * 処理概要: 内部リソースまたはテンソルメモリを解放する。
   * 実装理由: メモリリークを防止するため。
   */
  dispose(): unknown;
}

/**
 * 処理名: ランタイム入力インターフェース
 * 処理概要: input_idsテンソルおよびその他テンソル項目を保持する。
 * 実装理由: Transformersモデル呼び出し時の引数構造を定義するため。
 */
export interface RuntimeInputs { input_ids: { data: ArrayLike<number | bigint>; dims: readonly number[] }; [key: string]: unknown }

/**
 * 処理名: ランタイムプロセッサ型定義
 * 処理概要: テキストまたは画像を受け取りランタイム入力を返すプロセッサ関数を定義する。
 * 実装理由: トークナイズおよび画像前処理パイプラインを抽象化するため。
 */
export type RuntimeProcessor = ((text: string | null, image: unknown) => Promise<RuntimeInputs>) & { tokenizer: { all_special_tokens: readonly string[] } };

/**
 * 処理名: ランタイムモデルインターフェース
 * 処理概要: テンソル入力を処理し出力を返すモデル呼び出し可能オブジェクトを定義する。
 * 実装理由: モデル実行およびリソース破棄メソッドを型安全に管理するため。
 */
export interface RuntimeModel {
  /**
   * 処理名: モデル推論実行
   * 処理概要: 入力テンソルを受け取りモデル出力を返す。
   * 実装理由: ONNXモデル推論を実行するため。
   * @param inputs - モデル入力テンソル群。
   * @returns モデル出力テンソル群。
   */
  (inputs: RuntimeInputs): Promise<Record<string, unknown>>;
  /**
   * 処理名: モデルリソース破棄
   * 処理概要: モデルセッションと内部テンソルを破棄する。
   * 実装理由: メモリリークを防止するため。
   */
  dispose(): Promise<void>;
}

/**
 * 処理名: ポータブルランタイム境界インターフェース
 * 処理概要: Transformers.jsおよびORT関連APIの呼び出し境界を定義する。
 * 実装理由: 外部ランタイムモジュールへのアクセスを一元化するため。
 */
export interface PortableRuntime {
  env: { backends: { onnx: { wasm?: Record<string, unknown>; [key: string]: unknown } }; [key: string]: unknown };
  AutoConfig: {
    /**
     * 処理名: 設定読み込み
     * 処理概要: 指定識別子からモデル設定を読み出す。
     * 実装理由: モデル構成情報を取得するため。
     * @param id - モデルID。
     * @param options - 読み込みオプション。
     */
    from_pretrained(id: string, options?: Record<string, unknown>): Promise<Record<string, unknown>>;
  };
  AutoProcessor: {
    /**
     * 処理名: プロセッサ読み込み
     * 処理概要: 指定識別子からプロセッサインスタンスを構築する。
     * 実装理由: テキスト・画像プロセッサを生成するため。
     * @param id - モデルID。
     * @param options - 読み込みオプション。
     */
    from_pretrained(id: string, options?: Record<string, unknown>): Promise<RuntimeProcessor>;
  };
  AutoModel: {
    /**
     * 処理名: モデル読み込み
     * 処理概要: 指定識別子からモデルインスタンスを構築する。
     * 実装理由: 推論実行用モデルセッションを生成するため。
     * @param id - モデルID。
     * @param options - 読み込みオプション。
     */
    from_pretrained(id: string, options?: Record<string, unknown>): Promise<RuntimeModel>;
  };
  /**
   * 処理名: 画像コーデック初期化
   * 処理概要: JPEG/PNG/Resize用Wasmバイナリを初期化する。
   * 実装理由: 画像デコードパイプラインを準備するため。
   * @param assets - コーデックバイトデータ。
   */
  initializeImageCodecs(assets: ImageCodecBytes): Promise<void>;
  /**
   * 処理名: 画像デコード
   * 処理概要: バイナリデータからRawImageオブジェクトへデコードする。
   * 実装理由: 画像推論用ピクセルデータを生成するため。
   * @param bytes - 画像バイナリ。
   * @param mime - MIMEタイプ文字列。
   * @returns デコードされたRawImage。
   */
  decodeRawImage(bytes: Uint8Array, mime: string): Promise<unknown>;
}

/**
 * 処理名: 埋め込みリクエスト型定義
 * 処理概要: テキストまたは画像の埋め込み生成リクエストパラメータを定義する。
 * 実装理由: 推論エンジンへの入力を構造化するため。
 */
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
function collectDisposables(values: unknown, target: Set<DisposableResource>): void {
  if (typeof values !== "object" || values === null) return;
  for (const value of Object.values(values)) {
    if (typeof value === "object" && value !== null && typeof (value as { dispose?: unknown }).dispose === "function") target.add(value as DisposableResource);
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
   * 処理名: 推論入力テンソル準備
   * 処理概要: リクエスト種別（テキストまたは画像）に応じてプロセッサを呼び出し入力を生成する。
   * 実装理由: embedメソッド内の条件分岐複雑度を低減するため。
   * @param request - 推論リクエスト。
   * @param processor - ランタイムプロセッサ。
   * @returns 準備された入力テンソルまたはnull。
   */
  private async prepareInputs(request: EmbedRequest, processor: RuntimeProcessor): Promise<RuntimeInputs | null> {
    if (request.operation === "image") {
      if (request.bytes === null || request.bytes === undefined) return null;
      if (typeof request.mime !== "string") throw new VectorError("E_INPUT");
      const image = await this.runtime.decodeRawImage(request.bytes as Uint8Array, request.mime);
      return processor(null, image);
    }
    const text = formatTextInput(request.operation, request.body, request.title, processor.tokenizer.all_special_tokens);
    if (text === null) return null;
    return processor(text, null);
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
    const disposables = new Set<DisposableResource>();
    try {
      const inputs = await this.prepareInputs(request, processor);
      if (inputs === null) return null;
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
