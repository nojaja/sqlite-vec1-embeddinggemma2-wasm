import { validateEmbeddingOptions, type InitializationEnvironment } from "./options";
import { registerEmbeddingExtension } from "./registration";
import type { OfficialFactory, OfficialInferenceFactory, ProductInitOptions, ProductSqlite3 } from "./types";

export async function initializeOfficialRuntime(
  factory: OfficialFactory,
  options: ProductInitOptions = {},
  environment: InitializationEnvironment,
  prepare?: OfficialInferenceFactory
): Promise<ProductSqlite3> {
  const { embedding: embeddingOpt, ...officialOptions } = options;
  const readyOptions = validateEmbeddingOptions(embeddingOpt, environment);

  const sqlite3 = await factory(officialOptions);

  let activePool: any = null;
  if (typeof sqlite3.installOpfsSAHPoolVfs === "function") {
    const origInstall = sqlite3.installOpfsSAHPoolVfs.bind(sqlite3);
    sqlite3.installOpfsSAHPoolVfs = async (poolOptions?: any) => {
      const pool = await origInstall(poolOptions);
      activePool = pool;
      return pool;
    };
  }

  let session: any = null;
  if (readyOptions && prepare) {
    session = await prepare(readyOptions);
  }

  const extensionControl = registerEmbeddingExtension(
    sqlite3,
    session?.infer,
    session ? { identity: session.identity, timeoutMs: readyOptions?.sqlTimeoutMs, information: session.information } : undefined
  );

  let closed = false;
  const embeddingControl = {
    close: async (): Promise<void> => {
      if (closed) return;
      await extensionControl.close();
      if (session) {
        await session.close();
      }
      if (activePool && typeof activePool.pauseVfs === "function") {
        activePool.pauseVfs();
      }
      closed = true;
    }
  };

  return Object.assign(sqlite3, {
    embedding: embeddingControl
  });
}
