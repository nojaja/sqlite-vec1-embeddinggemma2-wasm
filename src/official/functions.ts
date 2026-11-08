import { VectorError } from "../errors";
import type { EmbeddingCall, EmbeddingInference } from "../inference/statement-embedding-cache";
import { formatTextInput } from "../inference/profile";

export { type EmbeddingCall, type EmbeddingInference };

export function embeddingSqlValue(
  name: string,
  args: readonly unknown[],
  infer?: EmbeddingInference
): Uint8Array | null {
  if (name === "embedding" || name === "embedding_query") {
    if (args.length >= 2) {
      const model = args[1];
      if (model !== "embeddinggemma-2" && model !== "ruri-v3") {
        throw new VectorError("E_INPUT");
      }
    }
    const body = args[0];
    if (body === null) {
      return null;
    }
    if (typeof body !== "string") {
      throw new VectorError("E_INPUT");
    }
    formatTextInput("query", body, undefined, []);

    if (!infer) {
      throw new VectorError("E_EMBEDDING_NOT_READY");
    }

    const operation = name === "embedding" ? "document" : "query";
    return infer({ operation, body, title: undefined });
  }

  if (name === "gemma_embed_query") {
    const body = args[0];
    if (body === null) {
      return null;
    }
    if (typeof body !== "string") {
      throw new VectorError("E_INPUT");
    }
    formatTextInput("query", body, undefined, []);

    if (!infer) {
      throw new VectorError("E_EMBEDDING_NOT_READY");
    }
    return infer({ operation: "query", body, title: undefined });
  }

  if (name === "gemma_embed_document") {
    const body = args[0];
    if (body === null) {
      return null;
    }
    if (typeof body !== "string") {
      throw new VectorError("E_INPUT");
    }
    const title = args[1];
    formatTextInput("document", body, title, []);

    if (!infer) {
      throw new VectorError("E_EMBEDDING_NOT_READY");
    }
    return infer({ operation: "document", body, title });
  }

  if (name === "gemma_embed_image") {
    const bytes = args[0];
    const mime = args[1];
    if (!(bytes instanceof Uint8Array) || typeof mime !== "string") {
      throw new VectorError("E_INPUT");
    }
    if (!infer) {
      throw new VectorError("E_EMBEDDING_NOT_READY");
    }
    return infer({ operation: "image", bytes, mime });
  }

  throw new VectorError("E_INPUT");
}
