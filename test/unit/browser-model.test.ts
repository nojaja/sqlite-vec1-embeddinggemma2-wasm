import { createBrowserModelReader } from "../../src/runtime-assets/browser-model";
import { VectorError } from "../../src/errors";

const assetBytes = new TextEncoder().encode("fixed browser model asset");
const assetSha256 = "3793b84e2d7ad43c12597a0b7311e3140743b02d1a56a0ca46a99c311ffb19de";

/**
 * 処理名: browser model reader fixture
 * 処理概要: 固定manifestと差替え可能なfetch境界を作る。
 * 実装理由: 外部通信なしでURL境界とhash検証を確認するため。
 * @param baseUrl - model資材root URL。
 * @param body - fetchが返すbytes。
 * @param expectedOrigin - packageを提供する期待origin。
 * @param status - HTTPレスポンスステータスコード。
 * @returns readerとfetch mock。
 */
function browserReaderFixture(baseUrl = "https://example.test/models/fixed/", body = assetBytes, expectedOrigin = "https://example.test", status = 200) {
  const fetcher = jest.fn().mockResolvedValue(new Response(body, { status }));
  const reader = createBrowserModelReader(
    [{ path: "onnx/model_q4.onnx", bytes: assetBytes.byteLength, sha256: assetSha256 }],
    baseUrl,
    expectedOrigin,
    fetcher
  );
  return { reader, fetcher };
}

/**
 * 処理名: browser固定資材読込み検証
 * 処理概要: 許可pathを一度だけ取得し独立bytesで返すことを確認する。
 * 実装理由: external dataをmanifestと同じ境界でbrowserへ供給するため。
 * @returns 検証完了。
 */
async function verifyBrowserAssetRead(): Promise<void> {
  const fixture = browserReaderFixture();
  const result = await fixture.reader("onnx/model_q4.onnx");
  expect(result).toEqual(assetBytes);
  expect(result).not.toBe(assetBytes);
  expect(fixture.fetcher).toHaveBeenCalledWith("https://example.test/models/fixed/onnx/model_q4.onnx", expect.objectContaining({ mode: "cors", cache: "no-store", credentials: "omit" }));
  await expect(fixture.reader("onnx/audio_encoder_q4.onnx")).resolves.toBeUndefined();
}

/**
 * 処理名: browser資材完全性拒否
 * 処理概要: sizeまたはSHA-256がmanifestと異なるresponseを拒否する。
 * 実装理由: HTTP成功を検証済みmodel資材として扱わないため。
 * @returns 検証完了。
 */
async function verifyBrowserAssetIntegrity(): Promise<void> {
  const wrongSize = browserReaderFixture(undefined, new Uint8Array([1]));
  await expect(wrongSize.reader("onnx/model_q4.onnx")).rejects.toEqual(new VectorError("E_ASSET_INTEGRITY"));
  const wrongHash = browserReaderFixture(undefined, new Uint8Array(assetBytes.byteLength));
  await expect(wrongHash.reader("onnx/model_q4.onnx")).rejects.toEqual(new VectorError("E_ASSET_INTEGRITY"));
  const notFound = browserReaderFixture(undefined, new Uint8Array(0), undefined, 404);
  await expect(notFound.reader("onnx/model_q4.onnx")).rejects.toEqual(new VectorError("E_ASSET_INTEGRITY"));
}

/**
 * 処理名: browser URL境界検証
 * 処理概要: 外部HTTPS CDNを許可しつつ、認証情報を含むrootや非HTTPSをfetch前に拒否する。
 * 実装理由: CDNオンデマンド取得を許可しつつ安全なエンドポイントのみに限定するため。
 */
async function verifyBrowserUrlBoundary(): Promise<void> {
  const cdn = browserReaderFixture("https://huggingface.co/onnx-community/embeddinggemma-2-ONNX/resolve/main/");
  await expect(cdn.reader("onnx/model_q4.onnx")).resolves.toEqual(assetBytes);
  expect(() => browserReaderFixture("https://user@example.test/models/")).toThrow("E_ASSET_INTEGRITY");
  expect(() => browserReaderFixture("http://example.test/models/", assetBytes, "http://example.test")).toThrow("E_ASSET_INTEGRITY");
  expect(() => browserReaderFixture("http://127.0.0.1/models/", assetBytes, "http://127.0.0.1")).not.toThrow();
}

test("G02: browser reads only hashed fixed model assets", verifyBrowserAssetRead);
test("G02: browser rejects corrupt model responses", verifyBrowserAssetIntegrity);
test("G02: browser rejects unsafe model roots", verifyBrowserUrlBoundary);