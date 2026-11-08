import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { initializeImageCodecs } from "../../../src/inference/image-codecs";
import { decodeRawImage } from "../../../src/inference/image";

/**
 * 処理名: 実Wasm画像codec検証
 * 処理概要: 固定codecでPNGを復号しRGBとresizeを確認する。
 * 実装理由: mock画像adapterだけでNode互換と判断しないため。
 * @returns codec検証完了。
 */
async function probeImageCodecs(): Promise<void> {
  await initializeImageCodecs({
    jpeg: await readFile("node_modules/@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm"),
    png: await readFile("node_modules/@jsquash/png/codec/pkg/squoosh_png_bg.wasm"),
    resize: await readFile("node_modules/@jsquash/resize/lib/resize/pkg/squoosh_resize_bg.wasm")
  });
  const bytes = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64"));
  const image = await decodeRawImage(bytes, "image/png");
  assert.equal(image.channels, 3);
  const resized = await image.resize(16, 16);
  assert.deepEqual(resized.size, [16, 16]);
  assert.equal(resized.data.length, 16 * 16 * 3);
  console.log(JSON.stringify({ stage: "wasm-image-codecs", width: resized.width, height: resized.height, channels: resized.channels, status: "passed" }));
}

/**
 * 処理名: codec失敗通知
 * 処理概要: エラー名とcodeだけを報告して非0終了する。
 * 実装理由: codec例外へ画像内容やローカルpathを含めないため。
 * @param failure - 検証失敗。
 */
function reportCodecFailure(failure: unknown): void {
  const code = typeof failure === "object" && failure !== null && "code" in failure ? String(failure.code) : "E_CODEC";
  console.error(JSON.stringify({ stage: "wasm-image-codecs", status: "failed", code }));
  process.exitCode = 1;
}

probeImageCodecs().catch(reportCodecFailure);