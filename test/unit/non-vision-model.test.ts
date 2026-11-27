import { createHash } from "node:crypto";
import { InferenceEngine, type PortableRuntime, type RuntimeModel, type RuntimeProcessor } from "../../src/inference/engine";
import { initializeInferenceEngine } from "../../src/inference/initialize";
import { validateModelManifest, type ModelAssetDigest } from "../../src/runtime-assets/model-contract";
import { PersistentModelCache, type PersistentCacheStorage } from "../../src/runtime-assets/persistent-model-cache";
import { VerifiedModelCache } from "../../src/runtime-assets/verified-cache";

/**
 * 処理名: SHA-256 計算ヘルパー
 * 処理概要: テスト用バイト列の SHA-256 hex 文字列を算出する。
 * @param data - 対象バイト列。
 * @returns 小文字 64 桁 hex 文字列。
 */
function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * 処理名: インメモリストレージアダプタ生成
 * 処理概要: PersistentModelCache テスト用のインメモリファイルシステムを提供する。
 * @returns ModelCacheStorageAdapter 実装。
 */
function createInMemoryStorageAdapter(): {
  storage: PersistentCacheStorage;
  files: Map<string, Uint8Array>;
} {
  const files = new Map<string, Uint8Array>();

  const storage: PersistentCacheStorage = {
    async exists(path: string): Promise<boolean> {
      return files.has(path);
    },
    async read(path: string): Promise<Uint8Array | undefined> {
      const data = files.get(path);
      return data ? new Uint8Array(data) : undefined;
    },
    async digest(path: string): Promise<{ bytes: number; sha256: string } | undefined> {
      const data = files.get(path);
      return data === undefined ? undefined : { bytes: data.length, sha256: sha256Hex(data) };
    },
    async createWriter(path: string) {
      const chunks: Uint8Array[] = [];
      return {
        async write(chunk: Uint8Array): Promise<void> {
          chunks.push(new Uint8Array(chunk));
        },
        async close(): Promise<void> {
          const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
          const merged = new Uint8Array(total);
          let offset = 0;
          for (const c of chunks) {
            merged.set(c, offset);
            offset += c.byteLength;
          }
          files.set(path, merged);
        },
        async abort(): Promise<void> {
          chunks.length = 0;
        }
      };
    },
    async commit(source: string, target: string): Promise<void> {
      const data = files.get(source);
      if (!data) {
        throw new Error(`Stage file missing: ${source}`);
      }
      files.set(target, new Uint8Array(data));
      files.delete(source);
    },
    async removeTree(prefix: string): Promise<void> {
      for (const key of Array.from(files.keys())) {
        if (key === prefix || key.startsWith(`${prefix}/`)) {
          files.delete(key);
        }
      }
    },
    async runExclusive<T>(_key: string, action: () => Promise<T>): Promise<T> {
      return action();
    }
  };

  return { storage, files };
}

/**
 * 処理名: テキスト専用モデル用ランタイムフィクスチャ生成
 * 処理概要: AutoProcessor を呼ぶと preprocessor_config.json 不在の SyntaxError を再現するモックランタイムを構築する。
 * @param options - モデル出力やプーリングの上書き設定。
 * @returns ランタイムと観測用モック。
 */
function createNonVisionRuntimeFixture(options?: {
  dimension?: number;
  modelOutput?: Record<string, unknown>;
  attentionMask?: BigInt64Array;
}) {
  const dimension = options?.dimension ?? 512;
  const inputDispose = jest.fn();
  const outputDispose = jest.fn();
  const modelDispose = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);

  const defaultOutput = options?.modelOutput ?? {
    last_hidden_state: {
      data: new Float32Array(dimension * 2).fill(0.5),
      dims: [1, 2, dimension],
      dispose: outputDispose
    }
  };

  const model = Object.assign(
    jest.fn().mockResolvedValue(defaultOutput),
    { dispose: modelDispose }
  );

  const tokenizer = Object.assign(
    jest.fn().mockResolvedValue({
      input_ids: {
        data: new BigInt64Array([101n, 202n]),
        dims: [1, 2],
        dispose: inputDispose
      },
      attention_mask: {
        data: options?.attentionMask ?? new BigInt64Array([1n, 1n]),
        dims: [1, 2],
        dispose: inputDispose
      }
    }),
    { all_special_tokens: ["[CLS]", "[SEP]", "[PAD]"] }
  );

  // AutoProcessor が呼ばれた場合は preprocessor_config.json 不在時の HTML 404 SyntaxError を再現する
  const autoProcessorFromPretrained = jest.fn().mockRejectedValue(
    new SyntaxError(`Unexpected token '<', "<!DOCTYPE "... is not valid JSON`)
  );
  const autoTokenizerFromPretrained = jest.fn().mockResolvedValue(tokenizer);
  const autoConfigFromPretrained = jest.fn().mockResolvedValue({ model_type: "modernbert" });
  const autoModelFromPretrained = jest.fn().mockResolvedValue(model);
  const initializeImageCodecs = jest.fn().mockResolvedValue(undefined);

  const runtime = {
    env: { backends: { onnx: { wasm: {} } } },
    AutoConfig: { from_pretrained: autoConfigFromPretrained },
    AutoProcessor: { from_pretrained: autoProcessorFromPretrained },
    AutoTokenizer: { from_pretrained: autoTokenizerFromPretrained },
    AutoModel: { from_pretrained: autoModelFromPretrained },
    initializeImageCodecs,
    decodeRawImage: jest.fn()
  } as unknown as PortableRuntime & {
    AutoTokenizer: { from_pretrained: jest.Mock };
  };

  return {
    runtime,
    model,
    tokenizer,
    autoProcessorFromPretrained,
    autoTokenizerFromPretrained,
    autoConfigFromPretrained,
    autoModelFromPretrained,
    initializeImageCodecs,
    inputDispose,
    outputDispose,
    modelDispose
  };
}

describe("Non-Vision Text-Only Model (e.g. ruri-v3, BERT, ModernBERT)", () => {
  test("TC1-A: profile.vision === false skips AutoProcessor/preprocessor_config.json and initializes via AutoTokenizer only", async () => {
    const fixture = createNonVisionRuntimeFixture({ dimension: 512 });

    const engine = await initializeInferenceEngine(fixture.runtime, {
      backend: "wasm",
      cache: {},
      modelRepository: "sirasagi62/ruri-v3-130m-ONNX",
      modelRevision: "main",
      dtype: "q4",
      dimension: 512,
      vision: false
    });

    // AutoProcessor (preprocessor_config.json) および画像コーデックは一切呼ばれないこと
    expect(fixture.autoProcessorFromPretrained).not.toHaveBeenCalled();
    expect(fixture.initializeImageCodecs).not.toHaveBeenCalled();

    // AutoTokenizer が local_files_only: true で呼ばれること
    expect(fixture.autoTokenizerFromPretrained).toHaveBeenCalledWith(
      "sirasagi62/ruri-v3-130m-ONNX",
      { revision: "main", local_files_only: true }
    );

    // クエリウォームアップ 1 回のみ実行されること
    expect(fixture.model).toHaveBeenCalledTimes(1);

    // 画像入力は E_INPUT で拒否されること
    await expect(
      engine.embed({ operation: "image", bytes: new Uint8Array([1, 2, 3]), mime: "image/png" })
    ).rejects.toThrow("E_INPUT");

    await engine.close();
  });

  test("TC1-B: Non-vision manifest validates and stores 5 text assets into PersistentModelCache without preprocessor_config.json", async () => {
    const assetPayloads = new Map<string, Uint8Array>([
      ["onnx/model_q4.onnx", new Uint8Array([1, 2, 3, 4])],
      ["config.json", new TextEncoder().encode('{"model_type":"modernbert"}')],
      ["tokenizer.json", new TextEncoder().encode('{"version":"1.0"}')],
      ["tokenizer_config.json", new TextEncoder().encode('{"model_max_length":8192}')],
      ["special_tokens_map.json", new TextEncoder().encode('{"cls_token":"[CLS]"}')]
    ]);

    const assets: ModelAssetDigest[] = Array.from(assetPayloads.entries()).map(([path, bytes]) => ({
      path,
      bytes: bytes.byteLength,
      sha256: sha256Hex(bytes)
    }));

    const manifestHash = sha256Hex(new TextEncoder().encode("ruri-v3-manifest"));
    const manifest = {
      schemaVersion: 1,
      modelId: "ruri-v3",
      repository: "sirasagi62/ruri-v3-130m-ONNX",
      revision: "main",
      artifactSetHash: manifestHash,
      fingerprint: manifestHash,
      profile: {
        vision: false,
        audio: false,
        dtype: "q4",
        dimension: 512
      },
      assets
    };
    validateModelManifest(manifest);

    expect(manifest.profile?.vision).toBe(false);
    expect(manifest.profile?.dimension).toBe(512);

    const { storage, files } = createInMemoryStorageAdapter();
    const persistentCache = new PersistentModelCache({
      modelId: manifest.modelId,
      assets: manifest.assets,
      artifactSetHash: manifest.artifactSetHash,
      manifestHash: manifest.fingerprint,
      storage,
      strictAllowlist: false,
      fetcher: async (asset: ModelAssetDigest) => {
        const bytes = assetPayloads.get(asset.path);
        if (!bytes) {
          throw new Error(`Unexpected asset fetch: ${asset.path}`);
        }
        return new Response(Buffer.from(bytes));
      }
    });

    await persistentCache.initialize("online");

    // テキスト関連資材がすべて保存されていること
    for (const asset of manifest.assets) {
      const stored = await persistentCache.read(asset.path);
      expect(stored).toEqual(assetPayloads.get(asset.path));
    }
    expect(files.has(`models/ruri-v3/${manifest.artifactSetHash}/ready.json`)).toBe(true);

    const verifiedCache = new VerifiedModelCache(
      manifest.assets,
      (path) => persistentCache.read(path),
      { repository: manifest.repository, revision: manifest.revision, strictAllowlist: false }
    );
    const modelRes = await verifiedCache.match(
      `https://huggingface.co/${manifest.repository}/resolve/${manifest.revision}/onnx/model_q4.onnx`
    );
    expect(modelRes).toBeDefined();
    expect(await verifiedCache.match(
      `https://huggingface.co/${manifest.repository}/resolve/${manifest.revision}/preprocessor_config.json`
    )).toBeUndefined();
  });

  test("TC2-A: Mean pooling extracts [1, 512] vector (2048-byte L2-normalized Float32 BLOB) from last_hidden_state using attention_mask", async () => {
    const dimension = 512;
    const seqLen = 3;
    const hiddenData = new Float32Array(seqLen * dimension);
    // トークン 0: 全要素 1.0, トークン 1: 全要素 3.0, トークン 2 (pad, mask=0): 全要素 99.0
    for (let d = 0; d < dimension; d++) {
      hiddenData[0 * dimension + d] = 1.0;
      hiddenData[1 * dimension + d] = 3.0;
      hiddenData[2 * dimension + d] = 99.0;
    }

    const fixture = createNonVisionRuntimeFixture({
      dimension,
      modelOutput: {
        last_hidden_state: {
          data: hiddenData,
          dims: [1, seqLen, dimension],
          dispose: jest.fn()
        }
      },
      attentionMask: new BigInt64Array([1n, 1n, 0n])
    });

    const engine = await initializeInferenceEngine(fixture.runtime, {
      backend: "wasm",
      cache: {},
      modelRepository: "sirasagi62/ruri-v3-130m-ONNX",
      modelRevision: "main",
      dtype: "q4",
      dimension,
      vision: false
    });

    const blob = await engine.embed({ operation: "query", body: "テスト文字列" });
    expect(blob).toBeInstanceOf(Uint8Array);
    expect(blob?.byteLength).toBe(512 * 4); // 2048 bytes

    // 全要素が等しいベクトルの L2 正規化値は 1 / sqrt(512)
    const view = new DataView(blob!.buffer, blob!.byteOffset, blob!.byteLength);
    const expectedVal = 1 / Math.sqrt(dimension);
    expect(view.getFloat32(0, true)).toBeCloseTo(expectedVal, 5);
    expect(view.getFloat32((dimension - 1) * 4, true)).toBeCloseTo(expectedVal, 5);

    await engine.close();
  });

  test("TC2-B: CLS pooling extracts first token [0] from last_hidden_state when pooling is 'cls'", async () => {
    const dimension = 512;
    const seqLen = 2;
    const hiddenData = new Float32Array(seqLen * dimension);
    // トークン 0 (CLS): [1, 0, 0, ...], トークン 1: [0, 1, 0, ...]
    hiddenData[0] = 2.0;
    hiddenData[dimension + 1] = 5.0;

    const fixture = createNonVisionRuntimeFixture({
      dimension,
      modelOutput: {
        last_hidden_state: {
          data: hiddenData,
          dims: [1, seqLen, dimension]
        }
      }
    });

    const engine = new InferenceEngine(fixture.runtime, {
      dimension,
      vision: false,
      pooling: "cls"
    } as ConstructorParameters<typeof InferenceEngine>[1]);

    const processor: RuntimeProcessor = Object.assign(
      async (text: string | null) =>
        fixture.tokenizer(text, { padding: true, truncation: true }),
      { tokenizer: fixture.tokenizer }
    );
    engine.attach(processor, fixture.model as unknown as RuntimeModel);

    const blob = await engine.embed({ operation: "query", body: "CLS テスト" });
    expect(blob).toBeInstanceOf(Uint8Array);
    expect(blob?.byteLength).toBe(2048);

    const view = new DataView(blob!.buffer, blob!.byteOffset, blob!.byteLength);
    expect(view.getFloat32(0, true)).toBeCloseTo(1.0, 5);
    expect(view.getFloat32(4, true)).toBeCloseTo(0.0, 5);

    await engine.close();
  });

  test("TC2-C: Rejects last_hidden_state with mismatched dimension or zero valid tokens with E_EMBEDDING_VALUE", async () => {
    const fixture = createNonVisionRuntimeFixture({
      dimension: 512,
      modelOutput: {
        last_hidden_state: {
          data: new Float32Array(768),
          dims: [1, 1, 768]
        }
      }
    });

    const engine = new InferenceEngine(fixture.runtime, { dimension: 512, vision: false });
    const processor: RuntimeProcessor = Object.assign(
      async (text: string | null) =>
        fixture.tokenizer(text, { padding: true, truncation: true }),
      { tokenizer: fixture.tokenizer }
    );
    engine.attach(processor, fixture.model as unknown as RuntimeModel);

    await expect(engine.embed({ operation: "query", body: "テスト" })).rejects.toThrow("E_EMBEDDING_VALUE");
    await engine.close();
  });
});
