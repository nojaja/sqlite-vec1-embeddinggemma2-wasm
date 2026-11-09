import { VectorError } from "../errors";

/**
 * 処理名: 画像コーデックバイナリインターフェース
 * 処理概要: JPEG/PNGデコーダおよびリサイズ用のWasmバイト配列を保持する。
 * 実装理由: 画像処理用WebAssemblyモジュールを型安全に注入するため。
 */
export interface ImageCodecBytes { jpeg: Uint8Array; png: Uint8Array; resize: Uint8Array }

/**
 * 処理名: 共通画像データインターフェース
 * 処理概要: ImageData互換のピクセル配列および幅・高さを定義する。
 * 実装理由: Nodeとブラウザ環境で共通の画像ピクセル構造を扱うため。
 */
export interface PortableImageData { data: Uint8ClampedArray; width: number; height: number }

let ready = false;
let jpegDecode: ((buffer: ArrayBuffer) => Promise<PortableImageData>) | undefined;
let pngDecode: ((buffer: ArrayBuffer) => Promise<PortableImageData>) | undefined;
let resizeImage: ((data: PortableImageData, options: Record<string, unknown>) => Promise<PortableImageData>) | undefined;

/**
 * 処理名: codec初期化
 * 処理概要: jSquashのJPEG/PNG/resizeを指定Wasm bytesで初期化する。
 * 実装理由: 同一package資材だけを使い未知I/Oを発生させないため。
 * @param assets - 3つのWasm bytes。
 */
export async function initializeImageCodecs(assets: ImageCodecBytes): Promise<void> {
  const jpeg = await import("@jsquash/jpeg/decode.js");
  const png = await import("@jsquash/png/decode.js");
  const resize = await import("@jsquash/resize/index.js");
  await jpeg.init({ wasmBinary: assets.jpeg } as never);
  await png.init(await WebAssembly.compile(assets.png as BufferSource));
  await resize.initResize(await WebAssembly.compile(assets.resize as BufferSource) as never);
  jpegDecode = jpeg.default as never;
  pngDecode = png.default as never;
  resizeImage = resize.default as never;
  ready = true;
}

/**
 * 処理名: 画像bytes復号
 * 処理概要: 初期化済みcodecでRGBAへ復号する。
 * 実装理由: 未初期化時に暗黙のI/Oを行わないため。
 * @param bytes - 画像bytes。
 * @param type - 形式。
 * @returns RGBA画像。
 */
export async function decodeImageBytes(bytes: Uint8Array, type: "png" | "jpeg"): Promise<PortableImageData> {
  const decode = type === "png" ? pngDecode : jpegDecode;
  if (!ready || decode === undefined) throw new VectorError("E_ENVIRONMENT");
  try {
    return await decode(bytes.slice().buffer);
  } catch {
    throw new VectorError("E_IMAGE_FORMAT");
  }
}

/**
 * 処理名: RGBA resize
 * 処理概要: catrom/stretch固定でresizeする。
 * 実装理由: 上流option差による結果変動を避けるため。
 * @param image - 入力RGBA画像。
 * @param width - 目標幅。
 * @param height - 目標高さ。
 * @returns resize後RGBA。
 */
export async function resizeRgba(image: PortableImageData, width: number, height: number): Promise<PortableImageData> {
  if (!ready || resizeImage === undefined) throw new VectorError("E_ENVIRONMENT");
  return resizeImage(image, { width, height, method: "catrom", fitMethod: "stretch", premultiply: false, linearRGB: false });
}
