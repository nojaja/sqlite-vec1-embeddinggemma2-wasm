import { VectorError } from "../errors";
import { decodeImageBytes, ImageDataLike, resizeRgba } from "./image-codecs";

/**
 * 処理名: 画像ヘッダーメタデータ型
 * 処理概要: 画像の幅、高さ、画像フォーマット種別を保持する。
 * 実装理由: 画像復号前のリソース境界検証およびルーティングのため。
 */
export interface ImageHeader {
  width: number;
  height: number;
  type: "png" | "jpeg";
}

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_DIMENSION = 16384;
const MAX_PIXELS = 16000000;

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/**
 * 処理名: PNG チャンク検証と寸法取得
 * 処理概要: PNG のバイナリ構造、IHDR 寸法、acTL (APNG) 検出、IEND 終端を検証する。
 * 実装理由: APNG 混入の排除および破損 PNG の安全な事前拒否のため。
 * @param bytes - PNG バイナリデータ。
 * @returns 画像ヘッダー。
 */
function parsePngHeader(bytes: Uint8Array): ImageHeader {
  if (bytes.length < 24) {
    throw new VectorError("E_IMAGE_FORMAT");
  }
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) {
      throw new VectorError("E_IMAGE_FORMAT");
    }
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ihdrLen = view.getUint32(8, false);
  const ihdrType = String.fromCharCode(...bytes.subarray(12, 16));
  if (ihdrLen !== 13 || ihdrType !== "IHDR") {
    throw new VectorError("E_IMAGE_FORMAT");
  }

  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);

  // チャンク走査で acTL の検出と IEND の終端検証
  let offset = 8;
  let hasIend = false;
  while (offset + 12 <= bytes.length) {
    const chunkLen = view.getUint32(offset, false);
    const chunkName = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (chunkName === "acTL") {
      throw new VectorError("E_IMAGE_FORMAT"); // APNG 拒否
    }
    if (chunkName === "IEND") {
      if (chunkLen !== 0 || offset + 12 !== bytes.length) {
        throw new VectorError("E_IMAGE_FORMAT");
      }
      hasIend = true;
      break;
    }
    offset += 12 + chunkLen;
  }

  if (!hasIend) {
    throw new VectorError("E_IMAGE_FORMAT");
  }

  return { width, height, type: "png" };
}

/**
 * 処理名: JPEG 寸法解析
 * 処理概要: JPEG バイナリから SOF マーカーを走査し幅と高さを抽出する。
 * 実装理由: Wasm 復号前に画像サイズを高速に検証するため。
 * @param bytes - JPEG バイナリデータ。
 * @returns 画像ヘッダー。
 */
function parseJpegHeader(bytes: Uint8Array): ImageHeader {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
    throw new VectorError("E_IMAGE_FORMAT");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = bytes[offset + 1];
    // SOF0 (0xC0), SOF1 (0xC1), SOF2 (0xC2)
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      const height = view.getUint16(offset + 5, false);
      const width = view.getUint16(offset + 7, false);
      return { width, height, type: "jpeg" };
    }
    if (marker === 0xd9 || marker === 0xda) {
      break;
    }
    const len = view.getUint16(offset + 2, false);
    offset += 2 + len;
  }
  throw new VectorError("E_IMAGE_FORMAT");
}

/**
 * 処理名: 画像入力事前検証
 * 処理概要: バイナリ型、MIME、バイト容量、フォーマット整合性、ピクセル境界を検証する。
 * 実装理由: 不正画像によるメモリ超過や推論エラーをデコード前に排除するため。
 * @param input - 入力バイナリデータ。
 * @param mime - 宣言された MIME タイプ。
 * @returns 検証済み画像ヘッダー。
 */
export function validateImageInput(input: unknown, mime: unknown): ImageHeader {
  if (!(input instanceof Uint8Array)) {
    throw new VectorError("E_INPUT");
  }
  if (typeof mime !== "string" || (mime !== "image/jpeg" && mime !== "image/png")) {
    throw new VectorError("E_IMAGE_FORMAT");
  }
  if (input.length > MAX_IMAGE_BYTES) {
    throw new VectorError("E_IMAGE_LIMIT");
  }
  if (input.length < 8) {
    throw new VectorError("E_IMAGE_FORMAT");
  }

  let header: ImageHeader;
  if (input[0] === 137 && input[1] === 80 && input[2] === 78 && input[3] === 71) {
    if (mime !== "image/png") {
      throw new VectorError("E_IMAGE_FORMAT");
    }
    header = parsePngHeader(input);
  } else if (input[0] === 0xff && input[1] === 0xd8 && input[2] === 0xff) {
    if (mime !== "image/jpeg") {
      throw new VectorError("E_IMAGE_FORMAT");
    }
    header = parseJpegHeader(input);
  } else {
    throw new VectorError("E_IMAGE_FORMAT");
  }

  const { width, height } = header;
  if (
    width < 1 ||
    height < 1 ||
    width > MAX_DIMENSION ||
    height > MAX_DIMENSION ||
    width * height > MAX_PIXELS
  ) {
    throw new VectorError("E_IMAGE_LIMIT");
  }

  return header;
}

/**
 * 処理名: RawImage クラス
 * 処理概要: 非圧縮画像ピクセルデータを保持し、RGB 変換やリサイズ操作を提供する。
 * 実装理由: Transformers.js プロセッサ向けに統一された画像アダプタを実装するため。
 */
export class RawImage {
  public readonly data: Uint8ClampedArray;
  public readonly width: number;
  public readonly height: number;
  public readonly channels: number;

  /**
   * 処理名: RawImage コンストラクタ
   * 処理概要: 画像データ、寸法、チャンネル数を検証し、独立したピクセルバッファを所有する。
   * 実装理由: 復号後のピクセルデータの境界安全性を保証するため。
   * @param data - 画素配列。
   * @param width - 画像幅。
   * @param height - 画像高さ。
   * @param channels - チャンネル数 (1..4)。
   */
  constructor(
    data: Uint8Array | Uint8ClampedArray,
    width: number,
    height: number,
    channels: number
  ) {
    if (
      width < 1 ||
      height < 1 ||
      width > MAX_DIMENSION ||
      height > MAX_DIMENSION ||
      width * height > MAX_PIXELS
    ) {
      throw new VectorError("E_IMAGE_LIMIT");
    }
    if (channels < 1 || channels > 4) {
      throw new VectorError("E_IMAGE_FORMAT");
    }
    if (data.byteLength !== width * height * channels) {
      throw new VectorError("E_IMAGE_FORMAT");
    }

    this.data = new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength);
    this.width = width;
    this.height = height;
    this.channels = channels;
  }

  /**
   * 処理名: 画像サイズ取得
   * 処理概要: [幅, 高さ] のタプルを返す。
   * 実装理由: 上流プロセッサインターフェース互換性のため。
   * @returns [width, height] 配列。
   */
  get size(): [number, number] {
    return [this.width, this.height];
  }

  /**
   * 処理名: RGB 画像への変換
   * 処理概要: チャンネル数に応じて透明度破棄またはグレースケール複製を行い、3チャンネル画像を生成する。
   * 実装理由: 埋め込みモデル入力仕様（3チャンネル RGB）に適合させるため。
   * @returns 3チャンネルの RawImage。
   */
  public rgb(): RawImage {
    if (this.channels === 3) {
      return this;
    }
    const pixelCount = this.width * this.height;
    const rgbData = new Uint8ClampedArray(pixelCount * 3);

    if (this.channels === 4) {
      for (let i = 0; i < pixelCount; i++) {
        rgbData[i * 3] = this.data[i * 4]!;
        rgbData[i * 3 + 1] = this.data[i * 4 + 1]!;
        rgbData[i * 3 + 2] = this.data[i * 4 + 2]!;
      }
    } else if (this.channels === 1 || this.channels === 2) {
      for (let i = 0; i < pixelCount; i++) {
        const gray = this.data[i * this.channels]!;
        rgbData[i * 3] = gray;
        rgbData[i * 3 + 1] = gray;
        rgbData[i * 3 + 2] = gray;
      }
    }

    return new RawImage(rgbData, this.width, this.height, 3);
  }

  /**
   * 処理名: 画像読み込み
   * 処理概要: RawImage または Blob から RawImage インスタンスを取得する。URL 入力は拒絶する。
   * 実装理由: 外部ネットワーク取得を防ぎ、安全なインメモリ画像入力のみを受け入れるため。
   * @param input - 入力オブジェクト (RawImage または Blob)。
   * @returns RawImage の Promise。
   */
  public static async read(input: unknown): Promise<RawImage> {
    if (input instanceof RawImage) {
      return input;
    }
    if (typeof (input as { arrayBuffer?: unknown })?.arrayBuffer === "function") {
      const blob = input as Blob;
      const type = blob.type;
      if (type === "image/png" || type === "image/jpeg") {
        const buf = new Uint8Array(await blob.arrayBuffer());
        return decodeRawImage(buf, type);
      }
    }
    throw new VectorError("E_INPUT");
  }

  /**
   * 処理名: 画像リサイズ
   * 処理概要: 指定寸法へリサイズした新しい RawImage を返す。寸法同一時は自己を返す。
   * 実装理由: モデル指定の入力寸法へ画質を維持して変換するため。
   * @param width - 目標幅。
   * @param height - 目標高さ。
   * @param _options - オプション引数 (未使用)。
   * @returns リサイズされた RawImage。
   */
  public async resize(width: number, height: number, _options?: unknown): Promise<RawImage> {
    if (this.width === width && this.height === height) {
      return this;
    }
    const rgbImg = this.rgb();
    const pixelCount = rgbImg.width * rgbImg.height;
    const rgbaData = new Uint8ClampedArray(pixelCount * 4);
    for (let i = 0; i < pixelCount; i++) {
      rgbaData[i * 4] = rgbImg.data[i * 3]!;
      rgbaData[i * 4 + 1] = rgbImg.data[i * 3 + 1]!;
      rgbaData[i * 4 + 2] = rgbImg.data[i * 3 + 2]!;
      rgbaData[i * 4 + 3] = 255;
    }

    const rgbaInput: ImageDataLike = {
      width: rgbImg.width,
      height: rgbImg.height,
      data: rgbaData
    };
    const resized = await resizeRgba(rgbaInput, width, height);
    const newPixelCount = width * height;
    const newRgbData = new Uint8ClampedArray(newPixelCount * 3);
    for (let i = 0; i < newPixelCount; i++) {
      newRgbData[i * 3] = resized.data[i * 4]!;
      newRgbData[i * 3 + 1] = resized.data[i * 4 + 1]!;
      newRgbData[i * 3 + 2] = resized.data[i * 4 + 2]!;
    }
    return new RawImage(newRgbData, width, height, 3);
  }
}

/**
 * 処理名: 生画像バイナリ復号
 * 処理概要: バイト配列と MIME から Wasm コーデックで復号し、RawImage を構築する。
 * 実装理由: 復号後のピクセル整合性を保証した上で RawImage を生成するため。
 * @param bytes - 画像バイナリ。
 * @param mime - MIME タイプ。
 * @returns 復号された RawImage。
 */
export async function decodeRawImage(bytes: Uint8Array, mime: string): Promise<RawImage> {
  const header = validateImageInput(bytes, mime);
  const decoded = await decodeImageBytes(bytes, header.type);
  const raw = new RawImage(decoded.data, decoded.width, decoded.height, 4);
  return raw.rgb();
}

/**
 * 処理名: load_image エイリアス
 * 処理概要: RawImage.read へのエイリアス関数。
 * 実装理由: Transformers.js 内部の load_image 呼び出しとの互換性のため。
 */
export const load_image = RawImage.read;
