import { RawImage, validateImageInput } from "../../src/inference/image";

/**
 * 処理名: PNG入力fixture
 * 処理概要: 再配布可能な1pixel PNGのbytesを生成する。
 * 実装理由: ネットワークや実codecなしでヘッダー境界を検査するため。
 * @returns 独立したPNG bytes。
 */
function pngFixture(): Uint8Array {
  return Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64"));
}

/**
 * 処理名: 画像事前検証
 * 処理概要: PNG寸法と宣言MIMEを検証する。
 * 実装理由: decode前に形式と容量を確定するため。
 */
function verifyPngInput(): void {
  expect(validateImageInput(pngFixture(), "image/png")).toEqual({ width: 1, height: 1, type: "png" });
  expect(validateImageInput.bind(undefined, pngFixture(), "image/jpeg")).toThrow("E_IMAGE_FORMAT");
  expect(validateImageInput.bind(undefined, pngFixture(), "image/webp")).toThrow("E_IMAGE_FORMAT");
  expect(validateImageInput.bind(undefined, "https://example.test/image.png", "image/png")).toThrow("E_INPUT");
  expect(validateImageInput.bind(undefined, new Uint8Array(0), "image/png")).toThrow("E_IMAGE_FORMAT");
}

/**
 * 処理名: 画像容量境界確認
 * 処理概要: bytes、各辺、画素数の上限を拒否する。
 * 実装理由: 圧縮画像の小さなheaderから巨大allocationを発生させないため。
 */
function verifyImageLimits(): void {
  expect(validateImageInput.bind(undefined, new Uint8Array(20 * 1024 * 1024 + 1), "image/png")).toThrow("E_IMAGE_LIMIT");
  for (const [width, height] of [[16385, 1], [4001, 4000], [0, 1]]) {
    const bytes = pngFixture();
    const view = new DataView(bytes.buffer);
    view.setUint32(16, width as number, false);
    view.setUint32(20, height as number, false);
    expect(validateImageInput.bind(undefined, bytes, "image/png")).toThrow("E_IMAGE_LIMIT");
  }
}

/**
 * 処理名: RGBとalpha破棄の検証
 * 処理概要: RGBAの透明度を背景合成せずRGBへ変換する。
 * 実装理由: 上流RawImageと同じalpha処理を両環境へ提供するため。
 */
function verifyRgbConversion(): void {
  const rgba = new RawImage(new Uint8ClampedArray([12, 34, 56, 0, 90, 80, 70, 255]), 2, 1, 4);
  const rgb = rgba.rgb();
  expect(rgb.size).toEqual([2, 1]);
  expect(rgb.channels).toBe(3);
  expect([...rgb.data]).toEqual([12, 34, 56, 90, 80, 70]);
  expect(rgb.rgb()).toBe(rgb);
  expect([...new RawImage(new Uint8ClampedArray([42]), 1, 1, 1).rgb().data]).toEqual([42, 42, 42]);
  expect([...new RawImage(new Uint8ClampedArray([42, 0]), 1, 1, 2).rgb().data]).toEqual([42, 42, 42]);
}

/**
 * 処理名: RawImage破損入力の検証
 * 処理概要: 復号後の寸法、channel、buffer長の不整合を拒否する。
 * 実装理由: decoderが返した値も信頼せず再検証するため。
 */
function verifyRawImageBounds(): void {
  expect(Reflect.construct.bind(undefined, RawImage, [new Uint8Array(3), 1, 1, 4])).toThrow("E_IMAGE_FORMAT");
  expect(Reflect.construct.bind(undefined, RawImage, [new Uint8Array(0), -1, 1, 3])).toThrow("E_IMAGE_LIMIT");
  expect(Reflect.construct.bind(undefined, RawImage, [new Uint8Array(5), 1, 1, 5])).toThrow("E_IMAGE_FORMAT");
}

test("R04: PNG and MIME preflight", verifyPngInput);
test("R04: encoded size and pixel limits", verifyImageLimits);
test("R04: portable RGB conversion", verifyRgbConversion);
test("R04: decoded image bounds", verifyRawImageBounds);

/**
 * 処理名: processor画像adapter契約
 * 処理概要: 同一画像のread/resizeと外部URL拒否を確認する。
 * 実装理由: processorが必要とする最小APIを外部I/Oなしで維持するため。
 * @returns adapter検証完了。
 */
async function verifyProcessorAdapter(): Promise<void> {
  const image = new RawImage(new Uint8ClampedArray([1, 2, 3]), 1, 1, 3);
  expect(await RawImage.read(image)).toBe(image);
  expect(await image.resize(1, 1)).toBe(image);
  await expect(RawImage.read("https://example.test/image.png")).rejects.toThrow("E_INPUT");
}

test("R04: processor adapter and no URL input", verifyProcessorAdapter);