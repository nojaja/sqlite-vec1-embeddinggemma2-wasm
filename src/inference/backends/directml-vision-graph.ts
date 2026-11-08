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

export interface VisionGraphPatchResult {
  bytes: Uint8Array;
  changed: number;
  sha256: string;
}

export function patchDirectMlVisionGraph(source: Uint8Array): VisionGraphPatchResult {
  if (!(source instanceof Uint8Array) || source.byteLength !== ORIGINAL_VISION_GRAPH_BYTES) {
    throw new VectorError("E_ASSET_INTEGRITY");
  }
  const sourceHash = createHash("sha256").update(source).digest("hex");
  if (sourceHash !== ORIGINAL_VISION_GRAPH_SHA256) {
    throw new VectorError("E_ASSET_INTEGRITY");
  }

  let model: any;
  try {
    model = ModelProto.decode(source);
  } catch {
    throw new VectorError("E_ASSET_INTEGRITY");
  }

  let changed = 0;
  function walkGraph(graph: any): void {
    if (!graph || !Array.isArray(graph.node)) return;
    for (const node of graph.node) {
      if (node.opType === "Reshape" && Array.isArray(node.attribute)) {
        for (const attr of node.attribute) {
          if (attr.name === "allowzero" && Number(attr.i) === 1) {
            attr.i = 0;
            changed++;
          }
        }
      }
    }
  }

  walkGraph(model.graph);
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

export class DirectMlModelCache {
  private readonly source: VerifiedModelCache;
  private lastPatchInfo?: VisionGraphPatchResult;

  public constructor(source: VerifiedModelCache) {
    this.source = source;
  }

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

  public async put(): Promise<never> {
    throw new VectorError("E_ASSET_INTEGRITY");
  }

  public patchInfo(): { changed: number; bytes: number; sha256: string } | undefined {
    return this.lastPatchInfo
      ? { changed: this.lastPatchInfo.changed, bytes: this.lastPatchInfo.bytes.byteLength, sha256: this.lastPatchInfo.sha256 }
      : undefined;
  }
}
