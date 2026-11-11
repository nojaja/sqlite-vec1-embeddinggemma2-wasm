import { VectorError } from "../errors";

/**
 * 処理名: 画像コーデックバイナリ型
 * 処理概要: JPEG、PNG、RESIZE の Wasm バイト配列を保持する構造体。
 * 実装理由: 画像復号およびリサイズ用の Wasm モジュールを一括管理するため。
 */
export interface ImageCodecBytes {
  jpeg: Uint8Array;
  png: Uint8Array;
  resize: Uint8Array;
}

/**
 * 処理名: ImageData 互換型
 * 処理概要: 幅、高さ、RGBA画素データを保持するインターフェース。
 * 実装理由: ブラウザ・Node.js 双方で同一の画像ピクセル表現を扱うため。
 */
export interface ImageDataLike {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

let mozjpegInit: ((bytes: Uint8Array) => Promise<unknown>) | null = null;
let mozjpegDecode: ((bytes: Uint8Array) => Promise<ImageDataLike>) | null = null;
let pngInit: ((bytes: Uint8Array) => Promise<unknown>) | null = null;
let pngDecode: ((bytes: Uint8Array) => Promise<ImageDataLike>) | null = null;
let resizeInit: ((bytes: Uint8Array) => Promise<unknown>) | null = null;
let resizeExec: ((image: ImageDataLike, width: number, height: number) => Promise<ImageDataLike>) | null = null;

let isInitialized = false;

/**
 * 処理名: 画像コーデック初期化
 * 処理概要: 提供された Wasm バイト配列を用いて jSquash コーデック（JPEG/PNG/RESIZE）を初期化する。
 * 実装理由: 実行環境に依存せず決定論的な画像処理パイプラインを確立するため。
 * @param assets - コーデック用 Wasm バイト配列集合。
 * @returns 初期化完了 Promise。
 */
export async function initializeImageCodecs(assets: ImageCodecBytes): Promise<void> {
  if (isInitialized) {
    return;
  }
  try {
    const [jpegMod, pngMod, resizeMod] = await Promise.all([
      import("@jsquash/jpeg/decode.js"),
      import("@jsquash/png/decode.js"),
      import("@jsquash/resize")
    ]);

    if (assets.jpeg && assets.jpeg.byteLength > 0) {
      const jpegWasmModule = new WebAssembly.Module(assets.jpeg as BufferSource);
      await jpegMod.init(jpegWasmModule);
    }
    if (assets.png && assets.png.byteLength > 0) {
      const pngWasmModule = new WebAssembly.Module(assets.png as BufferSource);
      await pngMod.init(pngWasmModule);
    }
    if (assets.resize && assets.resize.byteLength > 0) {
      const resizeWasmModule = new WebAssembly.Module(assets.resize as BufferSource);
      await resizeMod.initResize(resizeWasmModule);
    }

    mozjpegDecode = (bytes: Uint8Array) => jpegMod.default(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    pngDecode = (bytes: Uint8Array) => pngMod.default(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    resizeExec = (image: ImageDataLike, w: number, h: number) =>
      resizeMod.default(image as unknown as ImageData, {
        width: w,
        height: h,
        method: "catrom",
        fitMethod: "stretch",
        premultiply: false,
        linearRGB: false
      }) as unknown as Promise<ImageDataLike>;

    isInitialized = true;
  } catch (err) {
    throw new VectorError("E_INFERENCE");
  }
}

/**
 * 処理名: Node 環境での Wasm コーデック自動初期化
 * 処理概要: dist/image/ 配下の Wasm バイナリを読み込んで初期化する。
 * 実装理由: Node 実行時に fetch 不可な Wasm ファイルを直接読み込んで自動復旧するため。
 */
async function tryAutoInitializeNodeCodecs(): Promise<void> {
  if (isInitialized) return;
  try {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const distImageDir = path.resolve("dist/image");
    const jpegPath = path.join(distImageDir, "jpeg.wasm");
    const pngPath = path.join(distImageDir, "png.wasm");
    const resizePath = path.join(distImageDir, "resize.wasm");
    if (fs.existsSync(jpegPath) && fs.existsSync(pngPath) && fs.existsSync(resizePath)) {
      await initializeImageCodecs({
        jpeg: fs.readFileSync(jpegPath),
        png: fs.readFileSync(pngPath),
        resize: fs.readFileSync(resizePath)
      });
    }
  } catch {
    // ブラウザ環境やファイル不在時は無視
  }
}

/**
 * 処理名: 画像バイト列復号
 * 処理概要: JPEG または PNG のバイナリデータを ImageData 形式へデコードする。
 * 実装理由: Wasm デコーダーを用いて安全に RGBA 画素を展開するため。
 * @param bytes - 圧縮画像バイナリ。
 * @param type - 画像フォーマット ("jpeg" または "png")。
 * @returns 復号された ImageDataLike。
 */
export async function decodeImageBytes(
  bytes: Uint8Array,
  type: "jpeg" | "png"
): Promise<ImageDataLike> {
  try {
    if (!isInitialized) {
      await tryAutoInitializeNodeCodecs();
    }
    if (type === "jpeg") {
      if (!mozjpegDecode) {
        const jpegMod = await import("@jsquash/jpeg");
        mozjpegDecode = (b: Uint8Array) => jpegMod.decode(b);
      }
      return await mozjpegDecode(bytes);
    }
    if (!pngDecode) {
      const pngMod = await import("@jsquash/png");
      pngDecode = (b: Uint8Array) => pngMod.decode(b);
    }
    return await pngDecode(bytes);
  } catch {
    throw new VectorError("E_IMAGE_FORMAT");
  }
}

/**
 * 処理名: RGBA 画像リサイズ
 * 処理概要: ImageDataLike を指定寸法へ jSquash resize (catrom) でリサイズする。
 * 実装理由: モデル入力次元への正規化リサイズを統一的に実行するため。
 * @param image - 入力 ImageDataLike。
 * @param width - 出力幅。
 * @param height - 出力高さ。
 * @returns リサイズされた ImageDataLike。
 */
export async function resizeRgba(
  image: ImageDataLike,
  width: number,
  height: number
): Promise<ImageDataLike> {
  try {
    if (!isInitialized) {
      await tryAutoInitializeNodeCodecs();
    }
    if (!resizeExec) {
      const resizeMod = await import("@jsquash/resize");
      resizeExec = (img: ImageDataLike, w: number, h: number) =>
        resizeMod.default(img as unknown as ImageData, {
          width: w,
          height: h,
          method: "catrom",
          fitMethod: "stretch",
          premultiply: false,
          linearRGB: false
        }) as unknown as Promise<ImageDataLike>;
    }
    return await resizeExec(image, width, height);
  } catch {
    throw new VectorError("E_IMAGE_LIMIT");
  }
}
