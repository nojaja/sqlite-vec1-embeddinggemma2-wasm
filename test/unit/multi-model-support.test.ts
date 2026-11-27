import {
  createResponseBuffer,
  publishResponse,
  readResponse,
  waitResponse
} from "../../src/bridge/protocol";
import { embeddingToBlob, formatTextInput } from "../../src/inference/profile";
import {
  StatementEmbeddingCache,
  validateEmbeddingBlob
} from "../../src/inference/statement-embedding-cache";
import { embeddingSqlValue } from "../../src/official/functions";
import {
  officialMetadataRecord,
  validateOfficialMetadata
} from "../../src/official/metadata";
import { validateModelAssets, type ModelAssetDigest } from "../../src/runtime-assets/model-contract";
import { VerifiedModelCache } from "../../src/runtime-assets/verified-cache";
import { requestEmbedding } from "../../src/workers/db";
import { handleInferenceRequest } from "../../src/workers/inference";

/**
 * 処理名: 指定次元の正規化済み Float32 ベクトル BLOB 生成
 * 処理概要: テスト用に指定次元数の一様正規化ベクトルバイト列を生成する。
 * 実装理由: 512次元（2048バイト）や 768次元（3072バイト）等の任意次元テストデータを生成するため。
 * @param dimension - ベクトル次元数。
 * @param fillValue - 各要素に設定する値。
 * @returns リトルエンディアン Float32 バイト列。
 */
function makeFloat32Blob(dimension: number, fillValue = 0.1): Uint8Array {
  const bytes = new Uint8Array(dimension * 4);
  const view = new DataView(bytes.buffer);
  const norm = Math.sqrt(dimension * fillValue * fillValue);
  const normalized = fillValue / norm;
  for (let i = 0; i < dimension; i++) {
    view.setFloat32(i * 4, normalized, true);
  }
  return bytes;
}

describe("複数埋め込みモデル（ruri-v3 等）動的利用仕様", () => {
  test("UDF: embedding / embedding_query が登録済みモデル名 ruri-v3 を許容しモデル名を推論へ伝播する", () => {
    const allowedModels = new Set(["embeddinggemma-2", "ruri-v3"]);
    const blob512 = makeFloat32Blob(512);
    const infer = jest.fn(() => blob512);

    const fn = embeddingSqlValue as unknown as (
      name: string,
      args: readonly unknown[],
      infer?: (req: Record<string, unknown>) => Uint8Array | null,
      allowedModels?: ReadonlySet<string>
    ) => Uint8Array | null;

    const docResult = fn("embedding", ["顧客サポートの手順", "ruri-v3"], infer, allowedModels);
    expect(docResult).toBeInstanceOf(Uint8Array);
    expect(docResult?.byteLength).toBe(2048);
    expect(infer).toHaveBeenLastCalledWith(
      expect.objectContaining({
        operation: "document",
        body: "顧客サポートの手順",
        model: "ruri-v3"
      })
    );

    const queryResult = fn("embedding_query", ["顧客サポート", "ruri-v3"], infer, allowedModels);
    expect(queryResult?.byteLength).toBe(2048);
    expect(infer).toHaveBeenLastCalledWith(
      expect.objectContaining({
        operation: "query",
        body: "顧客サポート",
        model: "ruri-v3"
      })
    );

    expect(() => fn("embedding", ["text", "unknown-model"], infer, allowedModels)).toThrow("E_INPUT");
  });

  test("Protocol: SharedArrayBuffer が 512次元 (2048B) 等の動的次元数で publish / read / wait できる", () => {
    const response = createResponseBuffer();
    const payload512 = makeFloat32Blob(512);

    expect(publishResponse(response, payload512)).toBe(true);

    const header = new Int32Array(response, 0, 8);
    expect(header[1]).toBe(2048);
    expect(header[3]).toBe(512);

    const read = readResponse(response);
    expect(read.errorId).toBe(0);
    expect(read.payload).toEqual(payload512);

    const cancelSab = new SharedArrayBuffer(4);
    const waited = waitResponse(response, cancelSab, performance.now() + 1000);
    expect(waited.payload.byteLength).toBe(2048);
  });

  test("Protocol: 動的次元において payloadLen !== dim * 4 の改ざんヘッダーは E_PROTOCOL で拒否される", () => {
    const response = createResponseBuffer();
    const payload512 = makeFloat32Blob(512);
    expect(publishResponse(response, payload512)).toBe(true);

    const header = new Int32Array(response, 0, 8);
    Atomics.store(header, 3, 768);
    expect(() => readResponse(response)).toThrow("E_PROTOCOL");
  });

  test("Manifest / Assets: 11資材固定ではなく ruri-v3 等の任意有効資材セットを検証・許容する", () => {
    const ruriAssets: ModelAssetDigest[] = [
      { path: "onnx/model_q4.onnx", bytes: 1024, sha256: "a".repeat(64) },
      { path: "config.json", bytes: 512, sha256: "b".repeat(64) },
      { path: "tokenizer.json", bytes: 4096, sha256: "c".repeat(64) },
      { path: "tokenizer_config.json", bytes: 256, sha256: "d".repeat(64) }
    ];

    const validateFn = validateModelAssets as unknown as (
      assets: readonly ModelAssetDigest[],
      options?: { strictAllowlist?: boolean }
    ) => void;

    expect(() => validateFn(ruriAssets, { strictAllowlist: false })).not.toThrow();
    expect(() => validateFn([], { strictAllowlist: false })).toThrow("E_ASSET_INTEGRITY");
  });

  test("VerifiedModelCache: マニフェストの repository と revision から動的にキープレフィックスを解決する", async () => {
    const bytes = new TextEncoder().encode('{"hidden_size":512}');
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const sha256 = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const assets: ModelAssetDigest[] = [
      { path: "config.json", bytes: bytes.byteLength, sha256 }
    ];

    const CacheCtor = VerifiedModelCache as unknown as new (
      assets: readonly ModelAssetDigest[],
      reader: (path: string) => Promise<Uint8Array | undefined>,
      repoOptions?: { repository: string; revision: string }
    ) => VerifiedModelCache;

    const cache = new CacheCtor(
      assets,
      async (p) => (p === "config.json" ? bytes : undefined),
      {
        repository: "cl-nagoya/ruri-v3-30m",
        revision: "1234567890abcdef1234567890abcdef12345678"
      }
    );

    const localRes = await cache.match("/models/cl-nagoya/ruri-v3-30m/config.json");
    expect(localRes).toBeDefined();
    expect(localRes?.status).toBe(200);

    const remoteRes = await cache.match(
      "https://huggingface.co/cl-nagoya/ruri-v3-30m/resolve/1234567890abcdef1234567890abcdef12345678/config.json"
    );
    expect(remoteRes).toBeDefined();
    expect(remoteRes?.status).toBe(200);
  });

  test("Profile: embeddingToBlob と formatTextInput が動的次元数 (512) とモデル別プレフィックスに対応する", () => {
    const values = new Float32Array(512).fill(0.5);
    const toBlobFn = embeddingToBlob as unknown as (
      values: ArrayLike<number>,
      shape: readonly number[],
      dimension?: number
    ) => Uint8Array;

    const blob = toBlobFn(values, [1, 512], 512);
    expect(blob.byteLength).toBe(2048);

    const formatFn = formatTextInput as unknown as (
      operation: "query" | "document",
      body: unknown,
      title: unknown,
      specialTokens: readonly string[],
      prefixConfig?: { query?: string; document?: string }
    ) => string | null;

    const formattedQuery = formatFn("query", "顧客サポート", undefined, [], {
      query: "検索クエリ: ",
      document: "検索文書: "
    });
    expect(formattedQuery).toBe("検索クエリ: 顧客サポート");

    const formattedDoc = formatFn("document", "説明文", undefined, [], {
      query: "検索クエリ: ",
      document: "検索文書: "
    });
    expect(formattedDoc).toBe("検索文書: 説明文");
  });

  test("StatementCache: validateEmbeddingBlob と StatementEmbeddingCache が 512次元 (2048B) とモデル別キー分離に対応する", () => {
    const blob512 = makeFloat32Blob(512);
    const validateBlobFn = validateEmbeddingBlob as unknown as (
      value: unknown,
      expectedDimension?: number
    ) => void;

    expect(() => validateBlobFn(blob512, 512)).not.toThrow();
    expect(() => validateBlobFn(blob512, 768)).toThrow("E_EMBEDDING_VALUE");

    const cache = new StatementEmbeddingCache({
      modelId: "multi",
      revision: "r1",
      fingerprint: "f".repeat(64),
      profile: "multi",
      backend: "wasm",
      runtimeGeneration: 1
    });

    const blob768 = makeFloat32Blob(768);
    const infer = jest.fn((req: { model?: string }) =>
      req.model === "ruri-v3" ? blob512 : blob768
    );

    const r1 = cache.resolve(
      { operation: "query", body: "同一クエリ", title: undefined, model: "ruri-v3" } as never,
      infer as never
    );
    const r2 = cache.resolve(
      { operation: "query", body: "同一クエリ", title: undefined, model: "embeddinggemma-2" } as never,
      infer as never
    );

    expect(r1?.byteLength).toBe(2048);
    expect(r2?.byteLength).toBe(3072);
    expect(infer).toHaveBeenCalledTimes(2);
  });

  test("Metadata: officialMetadataRecord / validateOfficialMetadata が 512次元等の動的次元を保存・検証する", () => {
    const identity = {
      modelId: "cl-nagoya/ruri-v3-30m",
      revision: "r1",
      fingerprint: "a".repeat(64),
      profile: "ruri-v3/q4/512",
      dimension: 512,
      dtype: "q4",
      backend: "wasm",
      runtimeGeneration: 1
    };

    const record = officialMetadataRecord(identity);
    expect(record.dimension).toBe(512);
    expect(() => validateOfficialMetadata(record, identity)).not.toThrow();
  });

  test("Worker Bridge: requestEmbedding と handleInferenceRequest が model 指定で 512次元応答をルーティングする", async () => {
    const blob512 = makeFloat32Blob(512);
    const ruriEngine = { embed: jest.fn(async () => blob512) };
    const gemmaEngine = { embed: jest.fn(async () => makeFloat32Blob(768)) };
    const engines = new Map([
      ["ruri-v3", ruriEngine],
      ["embeddinggemma-2", gemmaEngine]
    ]);

    let capturedMessage: Record<string, unknown> | undefined;
    const port = {
      postMessage: jest.fn((msg: unknown) => {
        const typed = msg as { responseBuffer: SharedArrayBuffer; model?: string };
        capturedMessage = {
          ...(msg as Record<string, unknown>),
          responseBuffer: createResponseBuffer()
        };
        publishResponse(typed.responseBuffer, blob512);
      })
    };

    const cancelSab = new SharedArrayBuffer(4);
    const result = requestEmbedding(
      port,
      {
        jobId: "job-1",
        requestId: 1,
        generation: 0,
        operation: "query",
        body: "顧客サポート",
        model: "ruri-v3"
      } as never,
      cancelSab,
      1000
    );

    expect(result).toBeInstanceOf(Uint8Array);
    expect(result?.byteLength).toBe(2048);
    expect(capturedMessage?.model).toBe("ruri-v3");

    const isFatal = await (handleInferenceRequest as unknown as (
      engineOrMap: unknown,
      message: unknown,
      generation: number
    ) => Promise<boolean>)(engines, capturedMessage, 0);

    expect(isFatal).toBe(false);
    expect(ruriEngine.embed).toHaveBeenCalledTimes(1);
    expect(gemmaEngine.embed).not.toHaveBeenCalled();

    const workerRes = readResponse(capturedMessage?.responseBuffer as SharedArrayBuffer);
    expect(workerRes.errorId).toBe(0);
    expect(workerRes.payload.byteLength).toBe(2048);
  });
});
