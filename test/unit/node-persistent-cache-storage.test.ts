import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createNodePersistentCacheStorage } from "../../src/runtime-assets/node-persistent-cache-storage";

const testRoot = resolve(".build", `g05-node-storage-${process.pid}`);

/**
 * 処理名: test領域削除
 * 処理概要: repository配下のadapter fixtureを削除する。
 * 実装理由: test間でfilesystem状態を共有しないため。
 * @returns 削除完了。
 */
async function cleanup(): Promise<void> { await rm(testRoot, { recursive: true, force: true }); }

afterEach(cleanup);

/**
 * 処理名: Node保存基本契約検証
 * 処理概要: bounded write、digest、atomic commit、readを確認する。
 * 実装理由: Node filesystem adapterがpersistent cache契約を満たすことを保証するため。
 */
async function verifyNodeStorageLifecycle(): Promise<void> {
  const storage = await createNodePersistentCacheStorage(resolve(testRoot, "cache"), { maxWriteBytes: 4 });
  expect(await storage.exists("sets/missing/stage/file.bin")).toBe(false);
  expect(await storage.read("sets/missing/files/file.bin")).toBeUndefined();
  expect(await storage.digest("sets/missing/files/file.bin")).toBeUndefined();
  const writer = await storage.createWriter("sets/a/stage/file.bin");
  await writer.write(new Uint8Array([1, 2, 3, 4]));
  await expect(writer.write(new Uint8Array(5))).rejects.toThrow("E_ASSET_INTEGRITY");
  await writer.close();
  expect(await storage.digest("sets/a/stage/file.bin")).toEqual({
    bytes: 4,
    sha256: "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a"
  });
  await storage.commit("sets/a/stage/file.bin", "sets/a/files/file.bin");
  expect(await storage.exists("sets/a/stage/file.bin")).toBe(false);
  expect(await storage.read("sets/a/files/file.bin")).toEqual(new Uint8Array([1, 2, 3, 4]));
  const replacement = await storage.createWriter("sets/a/stage/file.bin");
  await replacement.write(new Uint8Array([4, 3, 2, 1]));
  await replacement.close();
  await storage.commit("sets/a/stage/file.bin", "sets/a/files/file.bin");
  expect(await storage.read("sets/a/files/file.bin")).toEqual(new Uint8Array([4, 3, 2, 1]));
}

/**
 * 処理名: Node path境界検証
 * 処理概要: traversal、絶対path、symlink経由の領域外参照を拒否する。
 * 実装理由: cacheDirectory外のmodelやDBを読み書きさせないため。
 */
async function verifyNodePathProtection(): Promise<void> {
  const cacheRoot = resolve(testRoot, "cache");
  const outside = resolve(testRoot, "outside");
  await mkdir(outside, { recursive: true });
  await writeFile(resolve(outside, "secret.bin"), new Uint8Array([9]));
  const storage = await createNodePersistentCacheStorage(cacheRoot);
  await expect(storage.read("../outside/secret.bin")).rejects.toThrow("E_ASSET_INTEGRITY");
  await expect(storage.read(resolve(outside, "secret.bin"))).rejects.toThrow("E_ASSET_INTEGRITY");
  await symlink(outside, resolve(cacheRoot, "escape"), "junction");
  await expect(storage.read("escape/secret.bin")).rejects.toThrow("E_ASSET_INTEGRITY");
  await expect(storage.createWriter("escape/new.bin")).rejects.toThrow("E_ASSET_INTEGRITY");
}

/**
 * 処理名: Node set lock検証
 * 処理概要: 同じkeyの処理が直列化され異なるkeyが独立することを確認する。
 * 実装理由: 同一artifact setのstage競合を防ぐため。
 */
async function verifyNodeSetLock(): Promise<void> {
  const storage = await createNodePersistentCacheStorage(resolve(testRoot, "cache"), { lockRetryMs: 1, lockTimeoutMs: 1000 });
  let active = 0;
  let maximum = 0;
  /** 処理名: lock対象処理 処理概要: 同時実行数を記録する。 実装理由: 排他性を観測するため。 @returns 処理完了。 */
  async function action(): Promise<void> {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 10));
    active -= 1;
  }
  await Promise.all([storage.runExclusive("a".repeat(64), action), storage.runExclusive("a".repeat(64), action)]);
  expect(maximum).toBe(1);
}

test("G05 Node adapter: bounded persistent lifecycle", verifyNodeStorageLifecycle);
test("G05 Node adapter: containment and symlink protection", verifyNodePathProtection);
test("G05 Node adapter: per-set locking", verifyNodeSetLock);
