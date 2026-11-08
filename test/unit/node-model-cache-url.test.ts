import { createNodeModelFetcher } from "../../src/sqlite/node-model-cache";
import type { ModelAssetDigest } from "../../src/runtime-assets/model-contract";

const asset: ModelAssetDigest = { path: "config.json", bytes: 2, sha256: "a".repeat(64) };

/**
 * 処理名: model base URL拒否検証
 * 処理概要: parse不能、外部HTTP、資格情報、query、fragment、非directoryを拒否する。
 * 実装理由: URL検証の各fail-closed分岐を回帰させないため。
 */
function verifyUnsafeUrls(): void {
  for (const value of [
    "not-a-url",
    "http://example.test/model/",
    "https://user@example.test/model/",
    "https://example.test/model/?x=1",
    "https://example.test/model/#part",
    "https://example.test/model"
  ]) expect(() => createNodeModelFetcher(value)).toThrow("E_INPUT");
}

/**
 * 処理名: loopback取得検証
 * 処理概要: test用loopback HTTPとmanifest pathだけを許可する。
 * 実装理由: 外部networkなしのintegration取得を製品allowlistと同じ経路で行うため。
 * @returns 取得検証完了。
 */
async function verifyLoopbackUrl(): Promise<void> {
  const fetcher = jest.fn(async (): Promise<Response> => new Response("{}"));
  const load = createNodeModelFetcher("http://127.0.0.1:3210/model/", fetcher as typeof fetch);
  await expect(load(asset)).resolves.toBeInstanceOf(Response);
  expect(fetcher).toHaveBeenCalledWith(new URL("http://127.0.0.1:3210/model/config.json"), { redirect: "error", credentials: "omit", cache: "no-store" });
}

test("Node model cache rejects unsafe base URLs", verifyUnsafeUrls);
test("Node model cache permits loopback integration source", verifyLoopbackUrl);
