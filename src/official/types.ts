import type { EmbeddingOptions, ReadyEmbeddingOptions } from "./options";
import type { EmbeddingCacheIdentity, EmbeddingInference } from "../inference/statement-embedding-cache";

export interface EmbeddingControl {
  close(): Promise<void>;
}

export interface Sqlite3Static {
  oo1: {
    DB: any;
    OpfsDb?: any;
  };
  capi: any;
  wasm: any;
  installOpfsSAHPoolVfs?(options?: any): Promise<any>;
  [key: string]: any;
}

export type ProductSqlite3 = Sqlite3Static & {
  embedding: EmbeddingControl;
};

export type ProductInitOptions = Record<string, unknown> & {
  embedding?: EmbeddingOptions;
};

export type OfficialFactory = (options?: Record<string, unknown>) => Promise<Sqlite3Static>;

export interface OfficialInferenceSession {
  infer: EmbeddingInference;
  identity: EmbeddingCacheIdentity;
  information: Record<string, unknown>;
  assertReady?(): void;
  close(): Promise<void>;
}

export type OfficialInferenceFactory = (
  options: ReadyEmbeddingOptions,
  extra?: any
) => Promise<OfficialInferenceSession>;
