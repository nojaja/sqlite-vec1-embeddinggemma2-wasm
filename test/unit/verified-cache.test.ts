import { createHash } from "node:crypto";
import { VerifiedModelCache } from "../../src/runtime-assets/verified-cache";
import { MODEL_ASSET_FILES, MODEL_REPOSITORY, MODEL_REVISION, type ModelAssetDigest } from "../../src/runtime-assets/model-contract";

const cachedBytes = new Uint8Array([1, 2, 3, 4]);

/**
 * 処理名: cache検証用digest集合
 * 処理概要: 固定4-byte fixtureのdigestを全許可pathへ割り当てる。
 * 実装理由: 実重みなしでキーと完全性の契約を検査するため。
 * @returns 必須資材digest集合。
 */
function cacheDigests(): ModelAssetDigest[] {
  const digest = createHash("sha256").update(cachedBytes).digest("hex");
  const assets: ModelAssetDigest[] = [];
  for (const definition of MODEL_ASSET_FILES) assets.push({ path: definition.path, bytes: cachedBytes.length, sha256: digest });
  return assets;
}

/**
 * 処理名: 検証済みcache読込み
 * 処理概要: local/remote両keyと独立Responseを確認する。
 * 実装理由: loaderのkey形式に対応しstream再使用を避けるため。
 * @returns 検証完了。
 */
async function verifyCacheRead(): Promise<void> {
  const reader = jest.fn<Promise<Uint8Array | undefined>, [string]>().mockResolvedValue(cachedBytes);
  const cache = new VerifiedModelCache(cacheDigests(), reader);
  for (const key of [`/models/${MODEL_REPOSITORY}/config.json`, `https://huggingface.co/${MODEL_REPOSITORY}/resolve/${MODEL_REVISION}/config.json`]) {
    const response = await cache.match(key);
    expect(response?.headers.get("Content-Length")).toBe("4");
    expect(new Uint8Array(await (response as Response).arrayBuffer())).toEqual(cachedBytes);
  }
  expect(reader).toHaveBeenCalledWith("config.json");
}

/**
 * 処理名: 未許可key検証
 * 処理概要: 別revision、未知file、traversalをI/O前に拒否する。
 * 実装理由: verified cacheを任意ファイル取得APIにしないため。
 * @param key - 未許可key。
 * @returns 検証完了。
 */
async function verifyUnknownKey(key: string): Promise<void> {
  const reader = jest.fn<Promise<Uint8Array | undefined>, [string]>();
  const cache = new VerifiedModelCache(cacheDigests(), reader);
  expect(await cache.match(key)).toBeUndefined();
  expect(reader).not.toHaveBeenCalled();
}

/**
 * 処理名: cache欠損と破損検証
 * 処理概要: 不足はmiss、size/hash不一致は完全性エラーにする。
 * 実装理由: ready markerだけで資材を信頼しないため。
 * @returns 検証完了。
 */
async function verifyCorruptCache(): Promise<void> {
  const reader = jest.fn<Promise<Uint8Array | undefined>, [string]>().mockResolvedValueOnce(undefined).mockResolvedValueOnce(new Uint8Array(3)).mockResolvedValueOnce(new Uint8Array(4));
  const cache = new VerifiedModelCache(cacheDigests(), reader);
  const key = `/models/${MODEL_REPOSITORY}/config.json`;
  expect(await cache.match(key)).toBeUndefined();
  await expect(cache.match(key)).rejects.toThrow("E_ASSET_INTEGRITY");
  await expect(cache.match(key)).rejects.toThrow("E_ASSET_INTEGRITY");
}

/**
 * 処理名: cache再格納検証
 * 処理概要: 検証済み内容以外のputを拒否する。
 * 実装理由: upstream cache書込みでmanifestを迂回させないため。
 * @returns 検証完了。
 */
async function verifyCachePut(): Promise<void> {
  const reader = jest.fn<Promise<Uint8Array | undefined>, [string]>();
  const cache = new VerifiedModelCache(cacheDigests(), reader);
  const key = `/models/${MODEL_REPOSITORY}/config.json`;
  await cache.put(key, new Response(cachedBytes));
  await expect(cache.put(key, new Response(new Uint8Array(4)))).rejects.toThrow("E_ASSET_INTEGRITY");
  await expect(cache.put("unknown", new Response(cachedBytes))).rejects.toThrow("E_ASSET_INTEGRITY");
}

test("G05: verified local and remote cache reads", verifyCacheRead);
test.each([
  "config.json",
  `/models/${MODEL_REPOSITORY}/../config.json`,
  `/models/${MODEL_REPOSITORY}/%2e%2e/config.json`,
  `/models/${MODEL_REPOSITORY}/onnx/audio_encoder_q4.onnx`,
  `https://huggingface.co/${MODEL_REPOSITORY}/resolve/main/config.json`,
  `https://example.test/${MODEL_REPOSITORY}/resolve/${MODEL_REVISION}/config.json`
])("G05: unknown key %s", verifyUnknownKey);
test("G05: every cache read validates bytes", verifyCorruptCache);
test("G05: only verified content may be put", verifyCachePut);