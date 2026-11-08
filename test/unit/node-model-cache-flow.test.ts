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

test("G07 Node inference initializes persistent cache before consumption", verifyPersistentFlow);
