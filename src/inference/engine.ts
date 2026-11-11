import { VectorError, ErrorCode } from "../errors";
import { assertTokenLimit, embeddingToBlob, formatTextInput } from "./profile";

/**
 * 処理名: ランタイム入力テンソル型
 * 処理概要: input_ids および関連テンソルを保持するオブジェクト型。
 * 実装理由: Transformers.js プロセッサからモデルへ渡すテンソル構造を統一するため。
 */
export interface RuntimeInputs {
  input_ids: {
    data: ArrayLike<number | bigint>;
    dims: readonly number[];
    dispose?: () => void;
  };
  [key: string]: unknown;
}

/**
 * 処理名: ランタイムプロセッサ型
 * 処理概要: テキストまたは画像をテンソルへ前処理し、特殊トークン一覧を保持する関数型。
 * 実装理由: AutoProcessor の呼び出し規約を抽象化するため。
 */
export type RuntimeProcessor = ((
  text: string | null,
  image: unknown
) => Promise<RuntimeInputs>) & {
  tokenizer: { all_special_tokens: readonly string[] };
};

/**
 * 処理名: ランタイムモデル型
 * 処理概要: テンソルを受け取って sentence_embedding などを非同期出力し、dispose メソッドを持つモデル型。
 * 実装理由: AutoModel の呼び出しおよびリソース解放を統一的に管理するため。
 */
export type RuntimeModel = ((
  inputs: RuntimeInputs
) => Promise<Record<string, unknown>>) & {
  dispose(): Promise<void>;
};

/**
 * 処理名: ポータブルランタイム型
 * 処理概要: ONNX Runtime 環境設定、各 Auto クラス、画像復号 API を提供する。
 * 実装理由: Node Wasm、ブラウザ、DirectML 各環境のランタイムを同一インターフェースで扱うため。
 */
export interface PortableRuntime {
  env: Record<string, unknown>;
  AutoConfig: {
    from_pretrained: (path: string, options?: unknown) => Promise<unknown>;
  };
  AutoProcessor: {
    from_pretrained: (path: string, options?: unknown) => Promise<unknown>;
  };
  AutoModel: {
    from_pretrained: (path: string, options?: unknown) => Promise<unknown>;
  };
  initializeImageCodecs?: (assets: unknown) => Promise<void>;
  decodeRawImage: (bytes: Uint8Array, mime: string) => Promise<unknown>;
}

/**
 * 処理名: 推論要求パラメータ型
 * 処理概要: query, document, image いずれかの操作引数を保持する共用型。
 */
export type EngineRequest =
  | { operation: "query" | "document"; body: unknown; title?: unknown }
  | { operation: "image"; bytes: unknown; mime: unknown };

/**
 * 処理名: InferenceEngine クラス
 * 処理概要: プロセッサとモデルを結合し、テキストまたは画像から 768 次元ベクトル BLOB を生成する。
 * 実装理由: トークン制限、中間テンソルの完全解放、未知例外秘匿、NULL 短絡を集中管理するため。
 */
export class InferenceEngine {
  private readonly runtime: PortableRuntime;
  private processor: RuntimeProcessor | null = null;
  private model: RuntimeModel | null = null;
  private isClosed = false;

  /**
   * 処理名: InferenceEngine コンストラクタ
   * 処理概要: ランタイムを保持して初期化する。
   * 実装理由: テスト用モックおよび実ランタイムを注入可能にするため。
   * @param runtime - ポータブルランタイムインスタンス。
   */
  constructor(runtime: PortableRuntime) {
    this.runtime = runtime;
  }

  /**
   * 処理名: プロセッサおよびモデルのアタッチ
   * 処理概要: プロセッサとモデルインスタンスをエンジンへ一度だけバインドする。
   * 実装理由: 二重初期化やクローズ後のアタッチを環境エラーとして拒否するため。
   * @param processor - ランタイムプロセッサ。
   * @param model - ランタイムモデル。
   */
  public attach(processor: RuntimeProcessor, model: RuntimeModel): void {
    if (this.isClosed || this.processor !== null || this.model !== null) {
      throw new VectorError("E_ENVIRONMENT");
    }
    this.processor = processor;
    this.model = model;
  }

  /**
   * 処理名: 埋め込み推論実行
   * 処理概要: 入力前処理、トークン数制限検査、モデル推論、L2 正規化、テンソル破棄を一貫して行う。
   * 実装理由: メモリリークを防止しつつ決定論的な Float32 ベクトル BLOB を生成するため。
   * @param request - 推論要求。
   * @returns 3072 バイトの Float32 BLOB、または NULL。
   */
  public async embed(request: EngineRequest): Promise<Uint8Array | null> {
    if (this.isClosed || !this.processor || !this.model) {
      throw new VectorError("E_ENVIRONMENT");
    }

    let formattedText: string | null = null;
    let decodedImage: unknown = null;

    if (request.operation === "query" || request.operation === "document") {
      formattedText = formatTextInput(
        request.operation,
        request.body,
        request.title,
        this.processor.tokenizer.all_special_tokens
      );
      if (formattedText === null) {
        return null;
      }
    } else if (request.operation === "image") {
      try {
        decodedImage = await this.runtime.decodeRawImage(
          request.bytes as Uint8Array,
          request.mime as string
        );
      } catch (err: unknown) {
        const code = (err as { code?: string })?.code;
        if (code === "E_IMAGE_FORMAT" || code === "E_IMAGE_LIMIT") {
          throw new VectorError(code as ErrorCode);
        }
        if (err instanceof VectorError) {
          throw err;
        }
        throw new VectorError("E_INFERENCE");
      }
    } else {
      throw new VectorError("E_INPUT");
    }

    let inputs: RuntimeInputs;
    try {
      if (decodedImage) {
        inputs = await this.processor(null, decodedImage);
      } else {
        inputs = await this.processor(formattedText, null);
      }
    } catch (err: unknown) {
      if (err instanceof VectorError) {
        throw err;
      }
      throw new VectorError("E_INFERENCE");
    }

    const disposables = new Set<{ dispose?: () => void }>();
    for (const key of Object.keys(inputs)) {
      const val = inputs[key] as { dispose?: () => void };
      if (typeof val?.dispose === "function") {
        disposables.add(val);
      }
    }

    try {
      if (!inputs.input_ids || !inputs.input_ids.data) {
        throw new VectorError("E_EMBEDDING_VALUE");
      }
      assertTokenLimit(inputs.input_ids.data.length);
    } catch (tokenErr) {
      for (const d of disposables) {
        try {
          d.dispose?.();
        } catch {}
      }
      throw tokenErr;
    }

    try {
      const output = await this.model(inputs);
      for (const key of Object.keys(output)) {
        const val = output[key] as { dispose?: () => void };
        if (typeof val?.dispose === "function") {
          disposables.add(val);
        }
      }

      const emb = output.sentence_embedding as
        | { data?: unknown; dims?: readonly number[] }
        | undefined;

      if (
        !emb ||
        !emb.data ||
        !(emb.data instanceof Float32Array) ||
        !Array.isArray(emb.dims) ||
        emb.dims.length !== 2 ||
        emb.dims[0] !== 1 ||
        emb.dims[1] !== 768
      ) {
        throw new VectorError("E_EMBEDDING_VALUE");
      }

      return embeddingToBlob(emb.data, emb.dims);
    } catch (err: unknown) {
      if (err instanceof VectorError) {
        throw err;
      }
      throw new VectorError("E_INFERENCE");
    } finally {
      for (const d of disposables) {
        try {
          d.dispose?.();
        } catch {}
      }
    }
  }

  /**
   * 処理名: エンジン安全クローズ
   * 処理概要: モデルリソースを破棄し、プロセッサ・モデルへの参照を解除する。
   * 実装理由: セッション終了時の確実なリソース回収と再クローズの安全性を保証するため。
   */
  public async close(): Promise<void> {
    if (this.isClosed) {
      return;
    }
    this.isClosed = true;
    if (this.model) {
      try {
        await this.model.dispose();
      } catch {}
    }
    this.processor = null;
    this.model = null;
  }
}
