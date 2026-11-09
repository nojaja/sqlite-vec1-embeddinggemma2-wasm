import { VectorError } from "../errors";
import { decodeImageBytes, resizeRgba } from "./image-codecs";

/**
 * 処理名: 画像ヘッダーインターフェース
 * 処理概要: 画像の幅・高さおよびフォーマット種別(PNG/JPEG)を定義する。
 * 実装理由: 画像デコード前のメタデータ検証結果を型安全に保持するため。
 */
export interface ImageHeader { width: number; height: number; type: "png" | "jpeg" }

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_SIDE = 16384;
const MAX_PIXELS = 16000000;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * 処理名: PNGチャンク走査検証
 * 処理概要: 各チャンクの境界と種別を確認し、IENDチャンク到達を検証する。
 * 実装理由: inspectPngのループ内複雑度を低減するため。
 * @param view - バイト列のDataView。
 * @param totalLength - バイト列全体の長さ。
 */
function scanPngChunks(view: DataView, totalLength: number): void {
  let offset = 8;
  while (offset < totalLength) {
    if (offset + 12 > totalLength) throw new VectorError("E_IMAGE_FORMAT");
    const length = view.getUint32(offset, false);
    const type = view.getUint32(offset + 4, false);
    const end = offset + 12 + length;
    if (end > totalLength || type === 0x6163544c) throw new VectorError("E_IMAGE_FORMAT");
    if (type === 0x49454e44) {
      if (length !== 0 || end !== totalLength) throw new VectorError("E_IMAGE_FORMAT");
      return;
    }
    offset = end;
  }
  throw new VectorError("E_IMAGE_FORMAT");
}

/**
 * 処理名: PNG構造検証
 * 処理概要: IHDR、各chunk境界、acTL有無、IEND終端を確認する。
 * 実装理由: 破損やAPNGをdecode前に拒否するため。
 * @param bytes - PNG bytes。
 * @returns IHDRの幅と高さ。
 */
function inspectPng(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.length < 33 || PNG_SIGNATURE.some((value, index) => bytes[index] !== value)) throw new VectorError("E_IMAGE_FORMAT");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8, false) !== 13 || view.getUint32(12, false) !== 0x49484452) throw new VectorError("E_IMAGE_FORMAT");
  const dimensions = { width: view.getUint32(16, false), height: view.getUint32(20, false) };
  assertDimensions(dimensions.width, dimensions.height);
  scanPngChunks(view, bytes.length);
  return dimensions;
}

/**
 * 処理名: SOFマーカー判定
 * 処理概要: マーカーがSOFフレームマーカーであるか確認する。
 * 実装理由: 複雑なマーカー条件式をカプセル化するため。
 * @param marker - JPEGマーカーコード。
 * @returns SOFマーカーかどうかの真偽値。
 */
function isSofMarker(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/**
 * 処理名: JPEGフレーム寸法取得
 * 処理概要: SOFマーカー領域から画像の高さと幅を読み出す。
 * 実装理由: inspectJpegのフレーム抽出処理を分離するため。
 * @param bytes - JPEGバイト配列。
 * @param offset - マーカーオフセット。
 * @returns 抽出された幅と高さ。
 */
function readJpegDimensions(bytes: Uint8Array, offset: number): { width: number; height: number } {
  if (offset + 9 > bytes.length) throw new VectorError("E_IMAGE_FORMAT");
  const height = ((bytes[offset + 5] as number) << 8) | (bytes[offset + 6] as number);
  const width = ((bytes[offset + 7] as number) << 8) | (bytes[offset + 8] as number);
  assertDimensions(width, height);
  return { width, height };
}

/**
 * 処理名: JPEG寸法取得
 * 処理概要: signature確認後にSOFマーカーから寸法を読む。
 * 実装理由: 復号前に資源上限を確定するため。
 * @param bytes - JPEG bytes。
 * @returns 幅と高さ。
 */
function inspectJpeg(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) throw new VectorError("E_IMAGE_FORMAT");
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) throw new VectorError("E_IMAGE_FORMAT");
    const marker = bytes[offset + 1] as number;
    if (marker === 0xff) { offset += 1; continue; }
    const length = ((bytes[offset + 2] as number) << 8) | (bytes[offset + 3] as number);
    if (isSofMarker(marker)) {
      return readJpegDimensions(bytes, offset);
    }
    if (length < 2) throw new VectorError("E_IMAGE_FORMAT");
    offset += 2 + length;
  }
  throw new VectorError("E_IMAGE_FORMAT");
}

/**
 * 処理名: 寸法上限検証
 * 処理概要: 各辺と総画素数の上限を確認する。
 * 実装理由: 小さなheaderから巨大allocationを起こさないため。
 * @param width - 幅。
 * @param height - 高さ。
 */
function assertDimensions(width: number, height: number): void {
  const valid = Number.isInteger(width) && Number.isInteger(height) && width >= 1 && height >= 1
    && width <= MAX_SIDE && height <= MAX_SIDE && width * height <= MAX_PIXELS;
  if (!valid) throw new VectorError("E_IMAGE_LIMIT");
}

/**
 * 処理名: 画像入力事前検証
 * 処理概要: 型、MIME、容量、signature、寸法を復号前に検証する。
 * 実装理由: 形式不正と資源超過をdecode前に分類するため。
 * @param input - 画像bytes。
 * @param mime - 宣言MIME。
 * @returns 画像headerの情報。
 */
export function validateImageInput(input: unknown, mime: unknown): ImageHeader {
  if (!(input instanceof Uint8Array) || typeof mime !== "string") throw new VectorError("E_INPUT");
  if (mime !== "image/png" && mime !== "image/jpeg") throw new VectorError("E_IMAGE_FORMAT");
  if (input.byteLength > MAX_BYTES) throw new VectorError("E_IMAGE_LIMIT");
  if (mime === "image/png") return { ...inspectPng(input), type: "png" };
  return { ...inspectJpeg(input), type: "jpeg" };
}

/**
 * 処理名: portable RawImage
 * 処理概要: 独立所有の画素とRGB変換・resizeを提供する。
 * 実装理由: Transformers.jsのprocessorが要求する最小画像APIをNode/browserで共通化するため。
 */
export class RawImage {
  public readonly data: Uint8ClampedArray;
  public readonly width: number;
  public readonly height: number;
  public readonly channels: number;

  /**
   * 処理名: RawImage生成
   * 処理概要: 寸法、channel、buffer長を検証して画素をcopyする。
   * 実装理由: decoderの出力も信頼せず再検証するため。
   * @param data - 画素。
   * @param width - 幅。
   * @param height - 高さ。
   * @param channels - channel数(1..4)。
   */
  public constructor(data: Uint8Array | Uint8ClampedArray, width: number, height: number, channels: number) {
    assertDimensions(width, height);
    if (!Number.isInteger(channels) || channels < 1 || channels > 4 || data.length !== width * height * channels) throw new VectorError("E_IMAGE_FORMAT");
    this.data = new Uint8ClampedArray(data);
    this.width = width;
    this.height = height;
    this.channels = channels;
  }

  /**
   * 処理名: 寸法取得
   * 処理概要: [width,height]を返す。
   * 実装理由: 上流RawImageのsize互換のため。
   * @returns 寸法。
   */
  public get size(): [number, number] { return [this.width, this.height]; }

  /**
   * 処理名: RGB変換
   * 処理概要: gray展開またはalpha破棄でRGBへ変換する。
   * 実装理由: 白背景合成なしで上流と同じ扱いにするため。
   * @returns RGB画像。RGBなら同instance。
   */
  public rgb(): RawImage {
    if (this.channels === 3) return this;
    const count = this.width * this.height;
    const out = new Uint8ClampedArray(count * 3);
    for (let index = 0; index < count; index += 1) {
      for (let channel = 0; channel < 3; channel += 1) {
        const source = this.channels <= 2 ? 0 : channel;
        out[index * 3 + channel] = this.data[index * this.channels + source] as number;
      }
    }
    return new RawImage(out, this.width, this.height, 3);
  }

  /**
   * 処理名: 画像読込み
   * 処理概要: RawImageはそのまま、JPEG/PNG Blobは復号して返す。
   * 実装理由: URLやpathを画像として取得しないため。
   * @param input - 入力。
   * @returns RawImage。
   */
  public static async read(input: unknown): Promise<RawImage> {
    if (input instanceof RawImage) return input;
    if (typeof Blob !== "undefined" && input instanceof Blob) {
      const bytes = new Uint8Array(await input.arrayBuffer());
      return decodeRawImage(bytes, input.type);
    }
    throw new VectorError("E_INPUT");
  }

  /**
   * 処理名: 画像resize
   * 処理概要: 同寸法は同instance、他はcatrom/stretchでRGBへ再標本化する。
   * 実装理由: 固定resize条件を上流optionで変えないため。
   * @param width - 目標幅。
   * @param height - 目標高さ。
   * @param _options - 無視される上流option。
   * @returns resize後RGB画像。
   */
  public async resize(width: number, height: number, _options?: unknown): Promise<RawImage> {
    if (width === this.width && height === this.height) return this;
    assertDimensions(width, height);
    const rgb = this.rgb();
    const rgba = new Uint8ClampedArray(rgb.width * rgb.height * 4);
    for (let index = 0; index < rgb.width * rgb.height; index += 1) {
      rgba.set(rgb.data.subarray(index * 3, index * 3 + 3), index * 4);
      rgba[index * 4 + 3] = 255;
    }
    const resized = await resizeRgba({ data: rgba, width: rgb.width, height: rgb.height }, width, height);
    return new RawImage(resized.data, resized.width, resized.height, 4).rgb();
  }
}

/**
 * 処理名: 画像復号
 * 処理概要: 事前検証後にWasm codecで復号しRGBへ変換する。
 * 実装理由: 復号後の寸法・長さも再検証するため。
 * @param bytes - 画像bytes。
 * @param mime - MIME。
 * @returns RGB RawImage。
 */
export async function decodeRawImage(bytes: Uint8Array, mime: string): Promise<RawImage> {
  const header = validateImageInput(bytes, mime);
  const decoded = await decodeImageBytes(bytes, header.type);
  return new RawImage(decoded.data, decoded.width, decoded.height, 4).rgb();
}

/**
 * 処理名: 上流互換画像読み込み関数
 * 処理概要: Transformers.jsのload_imageと互換性のある画像読み込み関数を提供する。
 * 実装理由: 上流パイプラインとの透過的な互換性を確保するため。
 */
export const load_image = RawImage.read;
