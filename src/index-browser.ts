import initialize, {
  sqlite3Worker1Promiser,
  sqlite3EmbeddingWorkerPromiser,
  resolveOfficialBrowserAssets
} from "./official/browser";

export default initialize;
export { sqlite3Worker1Promiser, sqlite3EmbeddingWorkerPromiser, resolveOfficialBrowserAssets };
export * from "./official/types";
