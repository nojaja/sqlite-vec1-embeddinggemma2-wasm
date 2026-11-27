import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { MODEL_ASSET_FILES, MODEL_REPOSITORY, MODEL_REVISION, type ModelAssetDigest } from "../../src/runtime-assets/model-contract";
import { DEFAULT_NODE_MODEL_BASE_URL, prepareNodeModelCache } from "../../src/sqlite/node-model-cache";

const cacheDirectory = resolve(".build", `node-model-flow-${process.pid}`);
const setHash = "a".repeat(64);
const manifestHash = "b".repeat(64);

/** 処理名: test cache削除。処理概要: repository内fixtureを除く。実装理由: test間でready markerを共有しないため。 @returns 削除完了。 */
async function cleanup(): Promise<void> { await rm(cacheDirectory, { recursive: true, force: true }); }

afterEach(cleanup);

/**
 * 処理名: model fixture生成
 * 処理概要: 全固定pathへ小さいdigestとbodyを作る。
 * 実装理由: 製品persistent/verified cache順序を実modelなしで検証するため。
 * @returns assetsとbody map。
 */
function fixture(): { assets: ModelAssetDigest[]; bodies: Map<string, Uint8Array> } {
  const bodies = new Map<string, Uint8Array>();
  const assets = MODEL_ASSET_FILES.map((entry, index) => {
    const body = new TextEncoder().encode(`node-cache-${index}`);
    bodies.set(entry.path, body);
    return { path: entry.path, bytes: body.length, sha256: createHash("sha256").update(body).digest("hex") };
  });
  return { assets, bodies };
}

/**
 * 処理名: online/offline flow検証
 * 処理概要: online取得後にfresh PersistentModelCacheを通信なしで再利用する。
 * 実装理由: VerifiedModelCache消費前の永続cache初期化を保証するため。
 */
async function verifyPersistentFlow(): Promise<void> {
  const data = fixture();
  const fetcher = jest.fn(async (input: string | URL | Request): Promise<Response> => {
    const path = new URL(typeof input === "string" || input instanceof URL ? input : input.url).pathname.split(`/resolve/${MODEL_REVISION}/`)[1] as string;
    return new Response(Uint8Array.from(data.bodies.get(path) ?? []));
  });
  const common = { cacheDirectory, baseUrl: DEFAULT_NODE_MODEL_BASE_URL, assets: data.assets, artifactSetHash: setHash, manifestHash };
  const online = await prepareNodeModelCache({ ...common, network: "allow" }, fetcher);
  expect(fetcher).toHaveBeenCalledTimes(MODEL_ASSET_FILES.length);
  const key = `https://huggingface.co/${MODEL_REPOSITORY}/resolve/${MODEL_REVISION}/config.json`;
  expect(new Uint8Array(await (await online.match(key) as Response).arrayBuffer())).toEqual(data.bodies.get("config.json"));
  fetcher.mockClear();
  const offline = await prepareNodeModelCache({ ...common, network: "offline" }, fetcher);
  expect(await offline.match(key)).toBeInstanceOf(Response);
  expect(fetcher).not.toHaveBeenCalled();
}

/**
 * 処理名: カスタムモデル用少数アセットfixture生成
 * 処理概要: 11資材ではない任意モデル（5資材）のdigestとbodyマップを生成する。
 * 実装理由: Node環境でも任意アセット数のモデルキャッシュ準備が動作することを検証するため。
 * @returns assetsとbody map。
 */
function customFixture(): { assets: ModelAssetDigest[]; bodies: Map<string, Uint8Array> } {
  const bodies = new Map<string, Uint8Array>();
  const paths = [
    "onnx/model_q4.onnx",
    "config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "config_sentence_transformers.json"
  ];
  const assets = paths.map((path, index) => {
    const body = new TextEncoder().encode(`custom-node-cache-${index}`);
    bodies.set(path, body);
    return { path, bytes: body.length, sha256: createHash("sha256").update(body).digest("hex") };
  });
  return { assets, bodies };
}

/**
 * 処理名: カスタムモデルonline/offline flow検証
 * 処理概要: 11資材以外のモデルで modelId/repository/revision/strictAllowlist を指定して永続キャッシュと検証キャッシュを初期化できることを確認する。
 * 実装理由: Node Worker におけるカスタムモデル利用時の E_ASSET_INTEGRITY 誤検知を防止するため。
 */
async function verifyCustomModelPersistentFlow(): Promise<void> {
  const repository = "cl-nagoya/ruri-v3-310m-ONNX";
  const revision = "v1.0.0";
  const data = customFixture();
  const fetcher = jest.fn(async (input: string | URL | Request): Promise<Response> => {
    const urlStr = typeof input === "string" || input instanceof URL ? input.toString() : input.url;
    const path = new URL(urlStr).pathname.split(`/resolve/${revision}/`)[1] as string;
    return new Response(Uint8Array.from(data.bodies.get(path) ?? []));
  });
  const common = {
    cacheDirectory,
    baseUrl: `https://huggingface.co/${repository}/resolve/${revision}/`,
    assets: data.assets,
    artifactSetHash: setHash,
    manifestHash,
    modelId: "ruri-v3",
    repository,
    revision,
    strictAllowlist: false
  };
  const online = await prepareNodeModelCache({ ...common, network: "allow" }, fetcher);
  expect(fetcher).toHaveBeenCalledTimes(data.assets.length);
  const key = `https://huggingface.co/${repository}/resolve/${revision}/config.json`;
  expect(new Uint8Array(await (await online.match(key) as Response).arrayBuffer())).toEqual(data.bodies.get("config.json"));
  fetcher.mockClear();
  const offline = await prepareNodeModelCache({ ...common, network: "offline" }, fetcher);
  expect(await offline.match(key)).toBeInstanceOf(Response);
  expect(fetcher).not.toHaveBeenCalled();
}

test("G07 Node inference initializes persistent cache before consumption", verifyPersistentFlow);
test("G07 Node inference initializes custom model cache with non-11 assets when strictAllowlist is false", verifyCustomModelPersistentFlow);
