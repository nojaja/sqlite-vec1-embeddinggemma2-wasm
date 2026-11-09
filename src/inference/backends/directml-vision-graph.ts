import { createHash } from "node:crypto";
import { Root } from "protobufjs";
import { VectorError } from "../../errors";
import type { VerifiedModelCache } from "../../runtime-assets/verified-cache";
import onnxProtoJson from "./onnx-proto.json";

const onnxRoot = Root.fromJSON(onnxProtoJson as unknown as Record<string, unknown>);
const ModelProto = onnxRoot.lookupType("onnx.ModelProto");

const ORIGINAL_VISION_GRAPH_BYTES = 159400;
const ORIGINAL_VISION_GRAPH_SHA256 = "7ea284226d4938f0ad921ab091f1d80a9ca699aa802984ef5cd5eec4f4761d96";

const PATCHED_VISION_GRAPH_BYTES = 159391;
const PATCHED_VISION_GRAPH_SHA256 = "e6115d00cb043a16d22376e513898471a911cd97d42832871f92599fd4279fe4";

/**
 * 処理名: ビジョングラフパッチ結果インターフェース
 * 処理概要: パッチ適用後のバイナリデータ、変更ノード数、SHA-256ハッシュを定義する。
 * 実装理由: DirectML用グラフ書き換え結果の整合性を検証するため。
 */
export interface VisionGraphPatchResult {
  bytes: Uint8Array;
  changed: number;
  sha256: string;
}

/**
 * 処理名: グラフ属性インターフェース
 * 処理概要: ONNXノード属性の名前および数値を定義する。
 * 実装理由: 属性の読み出しおよび書き換えを型安全に行うため。
 */
interface GraphAttribute {
  name?: string;
  i?: number | Long;
}

/**
 * 処理名: グラフノードインターフェース
 * 処理概要: ONNXノードの演算種別および属性リストを定義する。
 * 実装理由: ノード構造の検証と属性抽出を行うため。
 */
interface GraphNode {
  opType?: string;
  attribute?: GraphAttribute[];
}

/**
 * 処理名: モデルグラフインターフェース
 * 処理概要: ONNXモデルグラフのノード配列を定義する。
 * 実装理由: グラフ全体のノード走査を行うため。
 */
interface ModelGraph {
  node?: GraphNode[];
}

/**
 * 処理名: Reshapeノード属性パッチ適用
 * 処理概要: Reshapeノードのallowzero属性が1の場合に0へ書き換える。
 * 実装理由: DirectMLでのReshapeノード互換性を確保するため。
 * @param node - ONNXグラフノード。
 * @returns 変更された属性数。
 */
function patchReshapeNode(node: GraphNode): number {
  if (node.opType !== "Reshape" || !Array.isArray(node.attribute)) return 0;
  let changed = 0;
  for (const attr of node.attribute) {
    if (attr.name === "allowzero" && Number(attr.i) === 1) {
      attr.i = 0;
      changed++;
    }
  }
  return changed;
}

/**
 * 処理名: グラフ走査および属性パッチ
 * 処理概要: モデルグラフ内の全ノードを走査してReshapeノードのパッチを適用する。
 * 実装理由: 全allowzero属性を一括で修正するため。
 * @param graph - ONNXグラフオブジェクト。
 * @returns 変更された総数。
 */
function walkGraph(graph: ModelGraph | null | undefined): number {
  if (!graph || !Array.isArray(graph.node)) return 0;
  let total = 0;
  for (const node of graph.node) {
    total += patchReshapeNode(node);
  }
  return total;
}

/**
 * 処理名: DirectMLビジョングラフパッチ適用
 * 処理概要: vision_encoder_q4.onnx内のReshape allowzero属性を書き換えてハッシュ検証を行う。
 * 実装理由: DirectML実行時に未対応のallowzero属性によるクラッシュを防ぐため。
 * @param source - 元のONNXバイナリ。
 * @returns パッチ適用結果オブジェクト。
 */
export function patchDirectMlVisionGraph(source: Uint8Array): VisionGraphPatchResult {
  if (!(source instanceof Uint8Array) || source.byteLength !== ORIGINAL_VISION_GRAPH_BYTES) {
    throw new VectorError("E_ASSET_INTEGRITY");
  }
  const sourceHash = createHash("sha256").update(source).digest("hex");
  if (sourceHash !== ORIGINAL_VISION_GRAPH_SHA256) {
    throw new VectorError("E_ASSET_INTEGRITY");
  }

  let model: { graph?: ModelGraph };
  try {
    model = ModelProto.decode(source) as { graph?: ModelGraph };
  } catch {
    throw new VectorError("E_ASSET_INTEGRITY");
  }

  const changed = walkGraph(model.graph);
  if (changed !== 128) {
    throw new VectorError("E_ASSET_INTEGRITY");
  }

  const outputBuf = new Uint8Array(ModelProto.encode(model).finish());
  const hash = createHash("sha256").update(outputBuf).digest("hex");

  if (outputBuf.byteLength !== PATCHED_VISION_GRAPH_BYTES || hash !== PATCHED_VISION_GRAPH_SHA256) {
    throw new VectorError("E_ASSET_INTEGRITY");
  }

  return {
    bytes: outputBuf,
    changed,
    sha256: hash
  };
}

/**
 * 処理名: DirectML用モデルキャッシュラッパークラス
 * 処理概要: vision_encoder_q4.onnxの要求時に動的パッチを適用してResponseを返す。
 * 実装理由: DirectML環境でビジョングラフパッチを自動適用するため。
 */
export class DirectMlModelCache {
  private readonly source: VerifiedModelCache;
  private lastPatchInfo?: VisionGraphPatchResult;

  /**
   * 処理名: キャッシュインスタンス初期化
   * 処理概要: 元となる検証済みモデルキャッシュを保持する。
   * 実装理由: 内部キャッシュ要求を委譲するため。
   * @param source - 元のVerifiedModelCache。
   */
  public constructor(source: VerifiedModelCache) {
    this.source = source;
  }

  /**
   * 処理名: 資材キャッシュ検索
   * 処理概要: 要求パスに対応する資材を検索し、vision_encoderの場合はパッチ適用済みバイナリを返す。
   * 実装理由: Transformers内部からの資材要求に対してパッチ適用済みモデルを供給するため。
   * @param request - リクエストURLまたはオブジェクト。
   * @returns レスポンスオブジェクトまたはundefined。
   */
  public async match(request: string | Request): Promise<Response | undefined> {
    const key = typeof request === "string" ? request : request.url;
    const response = await this.source.match(request);
    if (!response) {
      return undefined;
    }
    if (key.endsWith("/vision_encoder_q4.onnx")) {
      const originalBytes = new Uint8Array(await response.arrayBuffer());
      const patch = patchDirectMlVisionGraph(originalBytes);
      this.lastPatchInfo = patch;
      return new Response(patch.bytes.slice(), {
        status: 200,
        headers: {
          "Content-Length": String(patch.bytes.byteLength),
          "Content-Type": "application/octet-stream"
        }
      });
    }
    return response;
  }

  /**
   * 処理名: キャッシュ保存拒否
   * 処理概要: put要求に対して常に整合性エラーを送出する。
   * 実装理由: 読み取り専用キャッシュとしての不変性を保証するため。
   */
  public async put(): Promise<never> {
    throw new VectorError("E_ASSET_INTEGRITY");
  }

  /**
   * 処理名: パッチ適用情報取得
   * 処理概要: 最後に適用されたビジョングラフパッチの統計情報を返す。
   * 実装理由: パッチ適用状況の検証および監査を可能にするため。
   * @returns パッチ情報オブジェクトまたはundefined。
   */
  public patchInfo(): { changed: number; bytes: number; sha256: string } | undefined {
    return this.lastPatchInfo
      ? { changed: this.lastPatchInfo.changed, bytes: this.lastPatchInfo.bytes.byteLength, sha256: this.lastPatchInfo.sha256 }
      : undefined;
  }
}
