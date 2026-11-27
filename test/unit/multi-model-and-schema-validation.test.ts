/**
 * 処理名: マルチモデル動的ロードおよび VECTOR(dim, 'model') 整合性チェックの TDD テスト。
 * 処理概要: docs/spec/v0.0.1 に追加されたマルチモデル登録、OPFS/Node モデル別キャッシュパス、
 *           Worker オンデマンドロード、Authorizer 自動解決、および E_MODEL_MISMATCH / E_EMBEDDING_VALUE 検証をテストする。
 * 実装理由: 実装に先立ち仕様契約をテストとして固定し、TDD の Red フェーズを確認するため。
 */
import { createHash } from "node:crypto";
import { buildSync } from "esbuild";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createResponseBuffer, readResponse } from "../../src/bridge/protocol";
import type { InferenceEngine } from "../../src/inference/engine";
import { registerEmbeddingExtension } from "../../src/official/registration";
import { validateEmbeddingOptions } from "../../src/official/options";
import type { OfficialFactory } from "../../src/official/types";
import type { ModelAssetDigest } from "../../src/runtime-assets/model-contract";
import {
  PersistentModelCache,
  type ArtifactWriter,
  type PersistentCacheStorage
} from "../../src/runtime-assets/persistent-model-cache";
import * as verifiedCacheModule from "../../src/runtime-assets/verified-cache";
import { handleInferenceRequest } from "../../src/workers/inference";
import {
  BrowserInferenceController,
  type BrowserControllerHost,
  type BrowserControllerInitialization
} from "../../src/workers/inference-browser-controller";

interface LocalBrowserInferencePort {
  onmessage: ((ev: { data?: unknown }) => void) | null;
  start(): void;
  close(): void;
}

/**
 * 処理名: 指定次元の正規化済み Float32 ベクトル BLOB 生成
 * 処理概要: テスト用に指定次元数の正規化済み Float32 リトルエンディアンバイト列を生成する。
 * 実装理由: 512次元 (2048B) と 768次元 (3072B) のベクトルを区別してテストするため。
 * @param dimension - ベクトル次元数。
 * @returns Float32 バイト列。
 */
function makeFloat32Blob(dimension: number): Uint8Array {
  const bytes = new Uint8Array(dimension * 4);
  new DataView(bytes.buffer).setFloat32(0, 1, true);
  return bytes;
}

/**
 * 処理名: メモリ内 ArtifactWriter
 * 処理概要: チャンクを蓄積し close 時に MemoryStorage へ保存するテスト用ライター。
 * 実装理由: ファイルシステムなしで PersistentModelCache のパス構造を検証するため。
 */
class MemoryWriter implements ArtifactWriter {
  private readonly chunks: Uint8Array[] = [];

  /**
   * 処理名: MemoryWriter コンストラクタ
   * 処理概要: 保存先ストレージと論理パスを受け取る。
   * 実装理由: 書き込み先のパスを記録するため。
   * @param storage - メモリストレージ。
   * @param path - 保存先パス。
   */
  constructor(private readonly storage: MemoryStorage, private readonly path: string) {}

  /**
   * 処理名: チャンク書き込み
   * 処理概要: チャンクのコピーを蓄積する。
   * 実装理由: バッファの独立性を保つため。
   * @param chunk - 入力バイト列。
   * @returns 書き込み完了 Promise。
   */
  async write(chunk: Uint8Array): Promise<void> {
    this.chunks.push(chunk.slice());
  }

  /**
   * 処理名: ライター確定
   * 処理概要: 蓄積したチャンクを結合してストレージへ格納する。
   * 実装理由: コミット前のステージファイルを作成するため。
   * @returns 完了 Promise。
   */
  async close(): Promise<void> {
    const total = this.chunks.reduce((acc, cur) => acc + cur.byteLength, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of this.chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    this.storage.files.set(this.path, merged);
  }

  /**
   * 処理名: ライター中断
   * 処理概要: 未確定チャンクを破棄する。
   * 実装理由: エラー時クリーンアップ契約を満たすため。
   * @returns 完了 Promise。
   */
  async abort(): Promise<void> {
    this.chunks.length = 0;
  }
}

/**
 * 処理名: メモリ内 PersistentCacheStorage
 * 処理概要: PersistentModelCache のパス生成と複数モデル共存をテストするためのインメモリストレージ。
 * 実装理由: 実 OPFS / FS なしでキャッシュパス構造を検証するため。
 */
class MemoryStorage implements PersistentCacheStorage {
  readonly files = new Map<string, Uint8Array>();

  /**
   * 処理名: 存在確認
   * 処理概要: 指定パスの存在可否を返す。
   * 実装理由: PersistentCacheStorage 契約実装のため。
   * @param path - 論理パス。
   * @returns 存在する場合 true。
   */
  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  /**
   * 処理名: 読み込み
   * 処理概要: 指定パスのバイト列コピーを返す。
   * 実装理由: PersistentCacheStorage 契約実装のため。
   * @param path - 論理パス。
   * @returns バイト列または undefined。
   */
  async read(path: string): Promise<Uint8Array | undefined> {
    return this.files.get(path)?.slice();
  }

  /**
   * 処理名: ダイジェスト取得
   * 処理概要: 指定パスのバイトサイズと SHA-256 を返す。
   * 実装理由: PersistentCacheStorage 契約実装のため。
   * @param path - 論理パス。
   * @returns 完全性情報または undefined。
   */
  async digest(path: string): Promise<{ bytes: number; sha256: string } | undefined> {
    const val = this.files.get(path);
    if (!val) return undefined;
    return {
      bytes: val.byteLength,
      sha256: createHash("sha256").update(val).digest("hex")
    };
  }

  /**
   * 処理名: ライター生成
   * 処理概要: 指定パスへの MemoryWriter を返す。
   * 実装理由: PersistentCacheStorage 契約実装のため。
   * @param path - 論理パス。
   * @returns ArtifactWriter。
   */
  async createWriter(path: string): Promise<ArtifactWriter> {
    return new MemoryWriter(this, path);
  }

  /**
   * 処理名: コミット
   * 処理概要: source から target へファイルを移動する。
   * 実装理由: ステージングから公開領域へのアトミック移動を再現するため。
   * @param source - 移動元パス。
   * @param target - 移動先パス。
   * @returns 完了 Promise。
   */
  async commit(source: string, target: string): Promise<void> {
    const val = this.files.get(source);
    if (!val) throw new Error(`missing source: ${source}`);
    this.files.set(target, val);
    this.files.delete(source);
  }

  /**
   * 処理名: ツリー削除
   * 処理概要: 指定プレフィックス配下のファイルを削除する。
   * 実装理由: ステージ削除を再現するため。
   * @param prefix - 削除プレフィックス。
   * @returns 完了 Promise。
   */
  async removeTree(prefix: string): Promise<void> {
    for (const key of Array.from(this.files.keys())) {
      if (key === prefix || key.startsWith(`${prefix}/`)) {
        this.files.delete(key);
      }
    }
  }

  /**
   * 処理名: 排他実行
   * 処理概要: テスト用簡易排他アクションを実行する。
   * 実装理由: PersistentCacheStorage 契約実装のため。
   * @param _key - ロックキー。
   * @param action - 実行アクション。
   * @returns アクション結果。
   */
  async runExclusive<T>(_key: string, action: () => Promise<T>): Promise<T> {
    return action();
  }
}

let sqliteFactory: OfficialFactory;

/**
 * 処理名: 実 SQLite テストランタイム準備
 * 処理概要: downloads/sqlite-official の Wasm ランタイムを .build へ複製し Jest 用にロードする。
 * 実装理由: registerEmbeddingExtension および Authorizer / VECTOR 検証を実 SQLite でテストするため。
 */
function prepareOfficialRuntime(): void {
  mkdirSync(".build", { recursive: true });
  copyFileSync("downloads/sqlite-official/sqlite3.wasm", ".build/sqlite3.wasm");
  copyFileSync("downloads/sqlite-official/sqlite3-node.mjs", ".build/sqlite3-node.mjs");
  const buildNodeMjs = readFileSync(".build/sqlite3-node.mjs", "utf8");
  if (!buildNodeMjs.includes("Array.isArray(text)")) {
    execFileSync(
      "git",
      ["apply", "--unidiff-zero", "--ignore-space-change", "--ignore-whitespace", "--directory=.build", "patches/sqlite-official.patch"],
      { stdio: "inherit" }
    );
  }
  const filename = resolve(".build/official-jest-runtime.js");
  buildSync({
    entryPoints: [".build/sqlite3-node.mjs"],
    outfile: filename,
    bundle: true,
    platform: "node",
    format: "cjs",
    supported: { "dynamic-import": false },
    define: { "import.meta.url": "__sqliteModuleUrl" },
    banner: { js: "const __sqliteModuleUrl=require('node:url').pathToFileURL(__filename).href;" }
  });
  const initialize = (require(filename) as { default: OfficialFactory }).default;
  sqliteFactory = (options) =>
    initialize({ wasmBinary: readFileSync("downloads/sqlite-official/sqlite3.wasm"), printErr: jest.fn(), ...options });
}

beforeAll(prepareOfficialRuntime);

describe("マルチモデル対応および DDL VECTOR(dim, 'model') 整合性チェック (TDD)", () => {
  test("1. options: defaultModel が models に未登録の場合は E_INPUT を送出する", () => {
    expect(() =>
      validateEmbeddingOptions(
        {
          models: {
            "ruri-v3": {
              repository: "cl-nagoya/ruri-v3-310m",
              revision: "main-rev",
              dimension: 512,
              dtype: "q4"
            }
          },
          defaultModel: "non-existent-model"
        },
        { worker: false, runtime: "node", platform: "win32", architecture: "x64" }
      )
    ).toThrow("E_INPUT");
  });

  test("2. PersistentModelCache: modelId を指定した場合 models/<sanitizedModelId>/<artifactSetHash>/ に保存され複数モデルが共存できる", async () => {
    const storage = new MemoryStorage();
    const contentA = new TextEncoder().encode("gemma-weights");
    const contentB = new TextEncoder().encode("ruri-weights");
    const shaA = createHash("sha256").update(contentA).digest("hex");
    const shaB = createHash("sha256").update(contentB).digest("hex");

    const assetsA: ModelAssetDigest[] = [{ path: "onnx/model_q4.onnx", bytes: contentA.byteLength, sha256: shaA }];
    const assetsB: ModelAssetDigest[] = [{ path: "onnx/model_q4.onnx", bytes: contentB.byteLength, sha256: shaB }];

    const CacheCtor = PersistentModelCache as unknown as new (opts: {
      storage: PersistentCacheStorage;
      assets: ModelAssetDigest[];
      artifactSetHash: string;
      manifestHash: string;
      modelId?: string;
      fetcher: (asset: ModelAssetDigest) => Promise<Response>;
    }) => PersistentModelCache;

    const hashA = "1".repeat(64);
    const hashB = "2".repeat(64);

    const cacheA = new CacheCtor({
      storage,
      assets: assetsA,
      artifactSetHash: hashA,
      manifestHash: "a".repeat(64),
      modelId: "google/embeddinggemma-2",
      fetcher: async () => new Response(contentA, { status: 200 })
    });

    const cacheB = new CacheCtor({
      storage,
      assets: assetsB,
      artifactSetHash: hashB,
      manifestHash: "b".repeat(64),
      modelId: "ruri-v3",
      fetcher: async () => new Response(contentB, { status: 200 })
    });

    await cacheA.initialize("online");
    await cacheB.initialize("online");

    expect(storage.files.has(`models/google_embeddinggemma-2/${hashA}/ready.json`)).toBe(true);
    expect(storage.files.has(`models/ruri-v3/${hashB}/ready.json`)).toBe(true);
    expect(await cacheA.read("onnx/model_q4.onnx")).toEqual(contentA);
    expect(await cacheB.read("onnx/model_q4.onnx")).toEqual(contentB);
  });

  test("3. MultiModelVerifiedCache: 複数モデルの repository/revision プレフィックスを衝突なくルーティングする", async () => {
    const MultiCtor = (verifiedCacheModule as Record<string, unknown>).MultiModelVerifiedCache as
      | (new () => {
          register(cache: verifiedCacheModule.VerifiedModelCache): void;
          match(req: string): Promise<Response | undefined>;
        })
      | undefined;

    expect(MultiCtor).toBeDefined();
    const multi = new MultiCtor!();

    const bytesA = new TextEncoder().encode('{"model":"gemma"}');
    const bytesB = new TextEncoder().encode('{"model":"ruri"}');
    const shaA = createHash("sha256").update(bytesA).digest("hex");
    const shaB = createHash("sha256").update(bytesB).digest("hex");

    const cacheA = new verifiedCacheModule.VerifiedModelCache(
      [{ path: "config.json", bytes: bytesA.byteLength, sha256: shaA }],
      async () => bytesA,
      { repository: "onnx-community/embeddinggemma-2-ONNX", revision: "rev-gemma" }
    );
    const cacheB = new verifiedCacheModule.VerifiedModelCache(
      [{ path: "config.json", bytes: bytesB.byteLength, sha256: shaB }],
      async () => bytesB,
      { repository: "cl-nagoya/ruri-v3-310m", revision: "rev-ruri" }
    );

    multi.register(cacheA);
    multi.register(cacheB);

    const resA = await multi.match("/models/onnx-community/embeddinggemma-2-ONNX/config.json");
    const resB = await multi.match("/models/cl-nagoya/ruri-v3-310m/config.json");
    expect(await resA?.text()).toBe('{"model":"gemma"}');
    expect(await resB?.text()).toBe('{"model":"ruri"}');
  });

  test("4. Worker 動的ロード: handleInferenceRequest が非同期エンジンリゾルバ経由で ruri-v3 をオンデマンドロードし 512 次元を返す", async () => {
    const loadedModels: string[] = [];
    const gemmaEngine = {
      embed: jest.fn(async () => makeFloat32Blob(768)),
      close: jest.fn(async () => undefined)
    } as unknown as InferenceEngine;

    const ruriEngine = {
      embed: jest.fn(async () => makeFloat32Blob(512)),
      close: jest.fn(async () => undefined)
    } as unknown as InferenceEngine;

    const resolveEngine = async (modelName?: string): Promise<InferenceEngine> => {
      const target = modelName ?? "embeddinggemma-2";
      if (!loadedModels.includes(target)) {
        loadedModels.push(target);
      }
      if (target === "ruri-v3") return ruriEngine;
      return gemmaEngine;
    };

    const buf1 = createResponseBuffer();
    const ok1 = await handleInferenceRequest(
      resolveEngine as unknown as InferenceEngine,
      {
        protocolVersion: 1,
        jobId: "job-1",
        requestId: 1,
        generation: 1,
        operation: "document",
        model: "ruri-v3",
        input: { text: "日本語テキスト" },
        responseBuffer: buf1
      },
      1
    );

    expect(ok1).toBe(false);
    expect(loadedModels).toEqual(["ruri-v3"]);
    const res1 = readResponse(buf1);
    expect(res1.errorId).toBe(0);
    expect(res1.payload.byteLength).toBe(512 * 4);
  });

  test("5. BrowserInferenceController: models 初期化で defaultModel のみ起動時ロードし、他モデルは初回呼び出しで動的ロードする", async () => {
    const messages: unknown[] = [];
    const host: BrowserControllerHost = {
      postMessage: (msg) => messages.push(msg),
      close: jest.fn()
    };
    const port: LocalBrowserInferencePort = {
      onmessage: null,
      start: jest.fn(),
      close: jest.fn()
    };

    const createdModels: string[] = [];
    const createEngine = jest.fn(async (init: BrowserControllerInitialization) => {
      const target = (init as unknown as { defaultModel?: string }).defaultModel ?? init.manifest.modelId;
      createdModels.push(target);
      return {
        embed: async () => makeFloat32Blob(target === "ruri-v3" ? 512 : 768),
        close: async () => undefined
      } as unknown as InferenceEngine;
    });

    const controller = new BrowserInferenceController(host, createEngine);
    controller.receiveControl({
      kind: "initialize",
      generation: 1,
      backend: "wasm",
      network: "offline",
      modelBaseUrl: "https://huggingface.co/onnx-community/embeddinggemma-2-ONNX/resolve/rev1/",
      manifest: {
        schemaVersion: 1,
        modelId: "embeddinggemma-2",
        repository: "onnx-community/embeddinggemma-2-ONNX",
        revision: "rev1",
        artifactSetHash: "a".repeat(64),
        fingerprint: "b".repeat(64),
        profile: { dimension: 768, dtype: "q4" },
        assets: []
      },
      models: {
        "embeddinggemma-2": {
          modelBaseUrl: "https://huggingface.co/onnx-community/embeddinggemma-2-ONNX/resolve/rev1/",
          manifest: {
            schemaVersion: 1,
            modelId: "embeddinggemma-2",
            repository: "onnx-community/embeddinggemma-2-ONNX",
            revision: "rev1",
            artifactSetHash: "a".repeat(64),
            fingerprint: "b".repeat(64),
            profile: { dimension: 768, dtype: "q4" },
            assets: []
          }
        },
        "ruri-v3": {
          modelBaseUrl: "https://huggingface.co/cl-nagoya/ruri-v3-310m/resolve/rev2/",
          manifest: {
            schemaVersion: 1,
            modelId: "ruri-v3",
            repository: "cl-nagoya/ruri-v3-310m",
            revision: "rev2",
            artifactSetHash: "c".repeat(64),
            fingerprint: "d".repeat(64),
            profile: { dimension: 512, dtype: "q4" },
            assets: []
          }
        }
      },
      defaultModel: "embeddinggemma-2",
      inferencePort: port as unknown as MessagePort
    } as unknown as BrowserControllerInitialization);

    await controller.whenIdle();
    expect(createdModels).toEqual(["embeddinggemma-2"]);

    const resBuf = createResponseBuffer();
    port.onmessage?.({
      data: {
        protocolVersion: 1,
        jobId: "j-ruri",
        requestId: 1,
        generation: 1,
        operation: "document",
        model: "ruri-v3",
        input: { text: "動的ロードテスト" },
        responseBuffer: resBuf
      }
    });
    await controller.whenIdle();

    const parsed = readResponse(resBuf);
    expect(parsed.errorId).toBe(0);
    expect(parsed.payload.byteLength).toBe(512 * 4);
  });

  test("6. SQLite 統合: VECTOR(512, 'ruri-v3') に対し第2引数省略時自動解決・異モデル E_MODEL_MISMATCH・異次元 E_EMBEDDING_VALUE を検証する", async () => {
    const api = await sqliteFactory();
    const infer = jest.fn((req: { model?: string }) => {
      if (req.model === "ruri-v3") {
        return makeFloat32Blob(512);
      }
      return makeFloat32Blob(768);
    });

    const control = registerEmbeddingExtension(api, infer, {
      models: {
        "embeddinggemma-2": { dimension: 768, dtype: "q4" },
        "ruri-v3": { dimension: 512, dtype: "q4" }
      },
      defaultModel: "embeddinggemma-2"
    });

    const db = new api.oo1.DB(":memory:");
    try {
      db.exec("CREATE TABLE ETOM (ID INTEGER PRIMARY KEY, DESCRIPTION TEXT, EMBEDDING VECTOR(512, 'ruri-v3')) STRICT;");

      // 第2引数省略時: カラム定義 VECTOR(512, 'ruri-v3') から 'ruri-v3' が自動解決される
      db.exec({
        sql: "INSERT INTO ETOM (ID, DESCRIPTION, EMBEDDING) VALUES (1, '顧客サポート', embedding('顧客サポート'));"
      });
      expect(infer).toHaveBeenLastCalledWith(expect.objectContaining({ model: "ruri-v3" }));

      // 異なるモデルを明示指定して VECTOR(512, 'ruri-v3') へ INSERT した場合: E_MODEL_MISMATCH
      expect(() =>
        db.exec("INSERT INTO ETOM (ID, DESCRIPTION, EMBEDDING) VALUES (2, '不一致モデル', embedding('不一致モデル', 'embeddinggemma-2'));")
      ).toThrow("E_MODEL_MISMATCH");

      // 異なる次元数 (768次元 = 3072B) の生 BLOB を直接 INSERT した場合: E_EMBEDDING_VALUE
      expect(() =>
        db.exec({
          sql: "INSERT INTO ETOM (ID, DESCRIPTION, EMBEDDING) VALUES (3, '異次元BLOB', ?);",
          bind: [makeFloat32Blob(768)]
        })
      ).toThrow("E_EMBEDDING_VALUE");

      // gemma_model_info() に登録モデル一覧が含まれること
      const info = JSON.parse(String(db.selectValue("SELECT gemma_model_info()")));
      expect(info.models).toBeDefined();
      expect(info.models["ruri-v3"]).toMatchObject({ dimension: 512, dtype: "q4" });
    } finally {
      db.close();
    }
    await control.close();
  });
});
