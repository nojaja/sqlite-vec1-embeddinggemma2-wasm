import nodeInitialize from "./official/node";
export default nodeInitialize;
export * from "./official/types";
export type { EmbeddingCacheIdentity, EmbeddingInference, EmbeddingCall, EmbeddingExecutionBudget, TextEmbeddingCall, ImageEmbeddingCall } from "./inference/statement-embedding-cache";
export type { EmbeddingOptions, ReadyEmbeddingOptions, Backend, InitializationEnvironment, ModelOptions } from "./official/options";
