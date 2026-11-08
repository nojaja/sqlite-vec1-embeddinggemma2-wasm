import { createHash } from "node:crypto";
import {
  PersistentModelCache,
  type ArtifactWriter,
  type PersistentCacheStorage
} from "../../src/runtime-assets/persistent-model-cache";
import { MODEL_ASSET_FILES, type ModelAssetDigest } from "../../src/runtime-assets/model-contract";

const SET_HASH = "a".repeat(64);
const MANIFEST_HASH = "b".repeat(64);

/**
 * 処理名: test用writer
 * 処理概要: chunkをmemoryへ蓄積しclose時にstorageへ保存する。
 * 実装理由: bounded writeとwriter lifecycleを観測するため。
 */
class MemoryWriter implements ArtifactWriter {
  private readonly chunks: Uint8Array[] = [];

  /**
   * 処理名: memory writer初期化
   * 処理概要: 保存先storageとpathを保持する。
   * 実装理由: function mockなしでwriter契約を再現するため。
   * @param storage - 保存先storage。
   * @param path - 保存先path。
   */
  constructor(private readonly storage: MemoryStorage, private readonly path: string) {}

  /** 処理名: chunk記録 処理概要: 独立copyを蓄積する。 実装理由: write上限を観測するため。
   * @param chunk - 入力bytes。
   * @returns 記録完了。
   */
  async write(chunk: Uint8Array): Promise<void> { this.storage.writeSizes.push(chunk.length); this.chunks.push(chunk.slice()); }

  /** 処理名: memory確定 処理概要: chunkを結合して保存する。 実装理由: close後のdigestを可能にするため。
   * @returns close完了。
   */
  async close(): Promise<void> { this.storage.files.set(this.path, concat(this.chunks)); }

  /** 処理名: memory中止 処理概要: 未確定chunkを破棄する。 実装理由: 失敗後の再利用を防ぐため。
   * @returns abort完了。
   */
  async abort(): Promise<void> { this.chunks.length = 0; }
}

/**
 * 処理名: test用storage
 * 処理概要: cache adapter契約をmemory上で記録する。
 * 実装理由: 実filesystemなしでstage、commit、削除境界を検証するため。
 */
class MemoryStorage implements PersistentCacheStorage {
  readonly files = new Map<string, Uint8Array>();
  readonly removed: string[] = [];
  readonly writeSizes: number[] = [];
  private gate = Promise.resolve();

  /** 処理名: 存在確認 処理概要: memory pathの有無を返す。 実装理由: stage残存判定を再現するため。
   * @param path - 論理path。
   * @returns 存在時true。
   */
  async exists(path: string): Promise<boolean> { return this.files.has(path); }

  /** 処理名: memory読込み 処理概要: 独立bytesを返す。 実装理由: 呼出し側の変更から保存値を守るため。
   * @param path - 論理path。
   * @returns 保存bytes。
   */
  async read(path: string): Promise<Uint8Array | undefined> { return this.files.get(path)?.slice(); }

  /** 処理名: memory digest 処理概要: 保存値のsizeとSHA-256を返す。 実装理由: environment別digest境界を再現するため。
   * @param path - 論理path。
   * @returns 完全性情報。
   */
  async digest(path: string): Promise<{ bytes: number; sha256: string } | undefined> {
    const value = this.files.get(path);
    return value === undefined ? undefined : { bytes: value.length, sha256: createHash("sha256").update(value).digest("hex") };
  }

  /** 処理名: writer作成 処理概要: chunk追記可能なmemory writerを返す。 実装理由: bounded writeを観測するため。
   * @param path - 論理path。
   * @returns writer。
   */
  async createWriter(path: string): Promise<ArtifactWriter> { return new MemoryWriter(this, path); }

  /** 処理名: memory commit 処理概要: stage値を公開pathへ移す。 実装理由: ready markerのcommit点を再現するため。
   * @param source - stage path。
   * @param target - 公開path。
   * @returns commit完了。
   */
  async commit(source: string, target: string): Promise<void> {
    const value = this.files.get(source);
    if (value === undefined) throw new Error("missing source");
    this.files.set(target, value);
    this.files.delete(source);
  }

  /** 処理名: tree削除 処理概要: 指定prefixだけをmemoryから削除する。 実装理由: revisionとDBの非削除を検証するため。
   * @param prefix - 削除対象prefix。
   * @returns 削除完了。
   */
  async removeTree(prefix: string): Promise<void> {
    this.removed.push(prefix);
    for (const path of this.files.keys()) if (path === prefix || path.startsWith(`${prefix}/`)) this.files.delete(path);
  }

  /** 処理名: 排他実行 処理概要: test内で処理をそのまま実行する。 実装理由: adapter lock契約を満たすため。
   * @param _key - lock key。
   * @param action - 実行処理。
   * @returns 処理結果。
   */
  async runExclusive<T>(_key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.gate;
    let release: (() => void) | undefined;
    this.gate = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await action(); }
    finally { release?.(); }
  }
}

/**
 * 処理名: chunk結合
 * 処理概要: writerへ渡されたbytesを一つへ結合する。
 * 実装理由: memory adapterの保存結果を再現するため。
 * @param chunks - 入力chunk。
 * @returns 結合bytes。
 */
function concat(chunks: readonly Uint8Array[]): Uint8Array {
  let size = 0;
  for (const chunk of chunks) size += chunk.length;
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

/**
 * 処理名: cache fixture作成
 * 処理概要: 全allowlist資材と取得mockを生成する。
 * 実装理由: 必須集合を小さいbytesで検証するため。
 * @param storage - 保存adapter。
 * @param chunkSize - write上限。
 * @returns cache、資材、fetch mock。
 */
function fixture(storage = new MemoryStorage(), chunkSize = 3) {
  const bodies = new Map<string, Uint8Array>();
  const assets: ModelAssetDigest[] = MODEL_ASSET_FILES.map((entry, index) => {
    const body = new TextEncoder().encode(`asset-${index}`);
    bodies.set(entry.path, body);
    return { path: entry.path, bytes: body.length, sha256: createHash("sha256").update(body).digest("hex") };
  });
  const fetcher = jest.fn(async (asset: ModelAssetDigest): Promise<Response> => new Response(Uint8Array.from(bodies.get(asset.path) ?? [])));
  const cache = new PersistentModelCache({ assets, artifactSetHash: SET_HASH, manifestHash: MANIFEST_HASH, storage, fetcher, chunkSize });
  return { assets, bodies, cache, fetcher, storage };
}

/**
 * 処理名: cold取得検証
 * 処理概要: 全資材をstage後にready markerで公開することを確認する。
 * 実装理由: 不全集合を実行可能にしないため。
 */
async function verifyColdAcquire(): Promise<void> {
  const data = fixture();
  await data.cache.initialize("cold");
  expect(data.fetcher).toHaveBeenCalledTimes(MODEL_ASSET_FILES.length);
  expect(Math.max(...data.storage.writeSizes)).toBeLessThanOrEqual(3);
  expect(await data.cache.read("config.json")).toEqual(data.bodies.get("config.json"));
  expect(data.storage.files.has(`sets/${SET_HASH}/ready.json`)).toBe(true);
  expect(data.storage.files.has(`sets/${SET_HASH}/stage/state.json`)).toBe(false);
}

/**
 * 処理名: offline再利用検証
 * 処理概要: cold取得済みcacheをnetworkなしで開く。
 * 実装理由: fresh processのoffline契約を保証するため。
 */
async function verifyOfflineReuse(): Promise<void> {
  const data = fixture();
  await data.cache.initialize("cold");
  data.fetcher.mockClear();
  await data.cache.initialize("offline");
  expect(data.fetcher).not.toHaveBeenCalled();
}

/**
 * 処理名: offline miss検証
 * 処理概要: 未取得時に通信せずcache missを返す。
 * 実装理由: offline modeのnetwork禁止を保証するため。
 */
async function verifyOfflineMiss(): Promise<void> {
  const data = fixture();
  await expect(data.cache.initialize("offline")).rejects.toThrow("E_MODEL_CACHE_MISS");
  expect(data.fetcher).not.toHaveBeenCalled();
}

/**
 * 処理名: 破損とonline修復検証
 * 処理概要: cold/offlineは破損を拒否しonlineだけ再取得する。
 * 実装理由: 自動fallbackなしの明示修復を保証するため。
 */
async function verifyCorruptionRecovery(): Promise<void> {
  const data = fixture();
  await data.cache.initialize("cold");
  data.storage.files.set(`sets/${SET_HASH}/files/config.json`, new Uint8Array([0]));
  await expect(data.cache.initialize("offline")).rejects.toThrow("E_ASSET_INTEGRITY");
  await expect(data.cache.initialize("cold")).rejects.toThrow("E_ASSET_INTEGRITY");
  data.fetcher.mockClear();
  await data.cache.initialize("online");
  expect(data.fetcher).toHaveBeenCalledTimes(MODEL_ASSET_FILES.length);
}

/**
 * 処理名: 中断と明示復旧検証
 * 処理概要: 失敗stageを保持しrecover後だけ再試行できることを確認する。
 * 実装理由: 障害証跡を暗黙削除しないため。
 */
async function verifyExplicitRecovery(): Promise<void> {
  const data = fixture();
  data.fetcher.mockRejectedValueOnce(new Error("stopped"));
  await expect(data.cache.initialize("cold")).rejects.toThrow("E_ASSET_INTEGRITY");
  expect(data.storage.files.has(`sets/${SET_HASH}/stage/state.json`)).toBe(true);
  await expect(data.cache.initialize("online")).rejects.toThrow("E_ASSET_INTEGRITY");
  await data.cache.recover();
  await data.cache.initialize("online");
  expect(data.storage.removed).toEqual([`sets/${SET_HASH}/stage`, `sets/${SET_HASH}/stage`]);
}

/**
 * 処理名: 保存領域分離検証
 * 処理概要: recoveryと修復が他revisionやDBを削除しないことを確認する。
 * 実装理由: model cache障害から利用者dataを守るため。
 */
async function verifyIsolation(): Promise<void> {
  const data = fixture();
  data.storage.files.set("sets/other/ready.json", new Uint8Array([1]));
  data.storage.files.set("databases/user.sqlite3", new Uint8Array([2]));
  data.storage.files.set(`sets/${SET_HASH}/stage/state.json`, new Uint8Array([3]));
  await data.cache.recover();
  expect(data.storage.files.has("sets/other/ready.json")).toBe(true);
  expect(data.storage.files.has("databases/user.sqlite3")).toBe(true);
}

/**
 * 処理名: 並行初期化検証
 * 処理概要: 同一artifact setの同時cold要求を一回の取得へ集約する。
 * 実装理由: 重複downloadとstage競合を防ぐため。
 */
async function verifyConcurrentAcquire(): Promise<void> {
  const data = fixture();
  await Promise.all([data.cache.initialize("cold"), data.cache.initialize("cold")]);
  expect(data.fetcher).toHaveBeenCalledTimes(MODEL_ASSET_FILES.length);
}

/**
 * 処理名: allowlist検証
 * 処理概要: 不完全manifestと未知path読込みを拒否する。
 * 実装理由: remote manifestによる資材集合差替えを防ぐため。
 */
async function verifyAllowlist(): Promise<void> {
  const data = fixture();
  expect(() => new PersistentModelCache({
    assets: data.assets.slice(1), artifactSetHash: SET_HASH, manifestHash: MANIFEST_HASH,
    storage: data.storage, fetcher: data.fetcher, chunkSize: 3
  })).toThrow("E_ASSET_INTEGRITY");
  await data.cache.initialize("cold");
  await expect(data.cache.read("../config.json")).resolves.toBeUndefined();
}

test("G05: cold acquisition stages and atomically publishes ready", verifyColdAcquire);
test("G05: offline reuses a complete verified set without network", verifyOfflineReuse);
test("G05: offline miss performs no network access", verifyOfflineMiss);
test("G05: corruption requires explicit online repair", verifyCorruptionRecovery);
test("G05: interrupted stage requires explicit recovery", verifyExplicitRecovery);
test("G05: recovery preserves other revisions and databases", verifyIsolation);
test("G05: concurrent cold initialization downloads one set", verifyConcurrentAcquire);
test("G05: manifest allowlist is mandatory", verifyAllowlist);
