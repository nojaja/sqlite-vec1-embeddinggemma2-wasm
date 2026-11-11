import * as crypto from "node:crypto";
import { VectorError } from "../../errors";
import { VerifiedModelCache } from "../../runtime-assets/verified-cache";

// onnx-proto は CommonJS
// eslint-disable-next-line @typescript-eslint/no-require-imports
const onnxProto = require("onnx-proto");

/**
 * 処理名: パッチ済みビジョングラフ情報型
 * 処理概要: パッチ適用後のバイト配列、変更箇所数、SHA-256 ハッシュを保持する。
 */
export interface PatchedVisionGraphInfo {
  bytes: Uint8Array;
  changed: number;
  sha256: string;
}

const ORIGINAL_GRAPH_BYTES = 159400;
const ORIGINAL_GRAPH_SHA256 =
  "7ea284226d4938f0ad921ab091f1d80a9ca699aa802984ef5cd5eec4f4761d96";

const PATCHED_GRAPH_BYTES = 159391;
const PATCHED_GRAPH_SHA256 =
  "e6115d00cb043a16d22376e513898471a911cd97d42832871f92599fd4279fe4";

/**
 * 処理名: DirectML 向けビジョングラフパッチ適用
 * 処理概要: ONNX Protobuf を用いて Reshape ノードの allowzero 属性 (128箇所) を 0 へ置換する。
 * 実装理由: DirectML 実行プロバイダーにおける Reshape 互換性不具合を決定論的に解消するため。
 * @param source - 元の vision_encoder_q4.onnx バイナリデータ。
 * @returns パッチ適用後の PatchedVisionGraphInfo。
 */
export function patchDirectMlVisionGraph(source: Uint8Array): PatchedVisionGraphInfo {
  if (!(source instanceof Uint8Array) || source.byteLength !== ORIGINAL_GRAPH_BYTES) {
    throw new VectorError("E_ASSET_INTEGRITY");
  }
  const originalSha = crypto.createHash("sha256").update(source).digest("hex");
  if (originalSha.toLowerCase() !== ORIGINAL_GRAPH_SHA256.toLowerCase()) {
    throw new VectorError("E_ASSET_INTEGRITY");
  }

  const ModelProto = onnxProto.onnx.ModelProto;
  let model: { graph?: { node?: Array<{ opType?: string; attribute?: Array<{ name?: string; i?: number | { toNumber?: () => number } }> }> } };
  try {
    model = ModelProto.decode(source);
  } catch {
    throw new VectorError("E_ASSET_INTEGRITY");
  }

  let changed = 0;
  if (model.graph && Array.isArray(model.graph.node)) {
    for (const node of model.graph.node) {
      if (node.opType === "Reshape" && Array.isArray(node.attribute)) {
        for (const attr of node.attribute) {
          if (attr.name === "allowzero") {
            const val = typeof attr.i === "number" ? attr.i : attr.i?.toNumber?.();
            if (val === 1) {
              attr.i = 0;
              changed++;
            }
          }
        }
      }
    }
  }

  const encoded = new Uint8Array(ModelProto.encode(model).finish());
  const sha256 = crypto.createHash("sha256").update(encoded).digest("hex");

  if (
    changed !== 128 ||
    encoded.length !== PATCHED_GRAPH_BYTES ||
    sha256.toLowerCase() !== PATCHED_GRAPH_SHA256.toLowerCase()
  ) {
    throw new VectorError("E_ASSET_INTEGRITY");
  }

  return { bytes: encoded, changed, sha256 };
}

/**
 * 処理名: DirectMlModelCache クラス
 * 処理概要: 元の VerifiedModelCache をラップし、vision graph のみメモリ内でパッチして Response を返す。
 * 実装理由: 永続キャッシュやディスク上の元モデルファイルを書き換えることなく DirectML 互換モデルを供給するため。
 */
export class DirectMlModelCache {
  private readonly source: VerifiedModelCache;
  private lastPatchInfo?: { changed: number; bytes: number; sha256: string };

  /**
   * 処理名: DirectMlModelCache コンストラクタ
   * 処理概要: ラップ対象の VerifiedModelCache を保持する。
   * @param source - 元の VerifiedModelCache。
   */
  constructor(source: VerifiedModelCache) {
    this.source = source;
  }

  /**
   * 処理名: キャッシュマッチング (読み込み)
   * 処理概要: vision_encoder_q4.onnx 読み込み時にインメモリパッチを適用した Response を返す。
   * @param request - リクエストキー。
   * @returns パッチ済み Response、または元の Response。
   */
  public async match(request: string | Request): Promise<Response | undefined> {
    const res = await this.source.match(request);
    if (!res) {
      return undefined;
    }

    const urlStr = typeof request === "string" ? request : request.url;
    if (urlStr.includes("vision_encoder_q4.onnx") && !urlStr.includes("vision_encoder_q4.onnx_data")) {
      const originalBytes = new Uint8Array(await res.arrayBuffer());
      const patched = patchDirectMlVisionGraph(originalBytes);
      this.lastPatchInfo = {
        changed: patched.changed,
        bytes: patched.bytes.byteLength,
        sha256: patched.sha256
      };
      const copy = new Uint8Array(patched.bytes);
      return new Response(copy, {
        headers: {
          "Content-Length": String(copy.byteLength),
          "Content-Type": "application/octet-stream"
        }
      });
    }

    return res;
  }

  /**
   * 処理名: キャッシュ格納拒否 (put)
   * 処理概要: DirectML キャッシュへの書き込み要求を完全性エラーとして拒絶する。
   * 実装理由: 永続キャッシュへの誤書き込みを防止するため。
   */
  public async put(): Promise<never> {
    throw new VectorError("E_ASSET_INTEGRITY");
  }

  /**
   * 処理名: パッチ適用情報取得
   * 処理概要: 直近に適用されたパッチの変更箇所数、バイト数、ハッシュを返す。
   * @returns パッチ情報、または未実行時 undefined。
   */
  public patchInfo(): { changed: number; bytes: number; sha256: string } | undefined {
    return this.lastPatchInfo;
  }
}
