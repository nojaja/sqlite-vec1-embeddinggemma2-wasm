import { validateEmbeddingOptions, type InitializationEnvironment } from "./options";
import { registerEmbeddingExtension } from "./registration";
import type { OfficialFactory, OfficialInferenceFactory, OfficialInferenceSession, ProductInitOptions, ProductSqlite3 } from "./types";

/**
 * 処理名: アクティブOPFSプール参照インターフェース
 * 処理概要: SAH Pool VFSの停止メソッドを提供する。
 * 実装理由: 終了時にVFSを確実に一時停止するため。
 */
interface ActivePoolHandle {
  /**
   * 処理名: VFS一時停止
   * 処理概要: OPFS VFSの同期操作を安全に停止する。
   * 実装理由: データベース終了時にファイルロックを解放するため。
   */
  pauseVfs?: () => void;
}

/**
 * 処理名: 公式SQLite3ランタイムおよび拡張初期化
 * 処理概要: 公式SQLiteファクトリを呼び出し、OPFS SAH Poolフックおよび埋め込み拡張を統合する。
 * 実装理由: Node/ブラウザ共通の初期化パイプラインを提供するため。
 * @param factory - 公式SQLite3生成ファクトリ。
 * @param options - 製品初期化オプション。
 * @param environment - スレッドおよびプラットフォーム環境情報。
 * @param prepare - 推論セッション生成ファクトリ（任意）。
 * @returns 拡張機能が組み込まれたProductSqlite3インスタンス。
 */
export async function initializeOfficialRuntime(
  factory: OfficialFactory,
  options: ProductInitOptions = {},
  environment: InitializationEnvironment,
  prepare?: OfficialInferenceFactory
): Promise<ProductSqlite3> {
  const { embedding: embeddingOpt, ...officialOptions } = options;
  const readyOptions = validateEmbeddingOptions(embeddingOpt, environment);

  const sqlite3 = await factory(officialOptions);

  let activePool: ActivePoolHandle | null = null;
  if (typeof sqlite3.installOpfsSAHPoolVfs === "function") {
    const origInstall = sqlite3.installOpfsSAHPoolVfs.bind(sqlite3);
    /**
     * 処理名: OPFS SAH Poolインストールフック
     * 処理概要: SAH Poolをインストールし、インスタンスの参照を保持する。
     * 実装理由: 終了時にPoolを確実にクローズできるようにするため。
     * @param poolOptions - プール初期化オプション。
     * @returns 生成されたプールインスタンス。
     */
    const installHook = async (poolOptions?: unknown): Promise<unknown> => {
      const pool = await origInstall(poolOptions);
      activePool = pool as ActivePoolHandle;
      return pool;
    };
    sqlite3.installOpfsSAHPoolVfs = installHook;
  }

  let session: OfficialInferenceSession | null = null;
  if (readyOptions && prepare) {
    session = await prepare(readyOptions);
  }

  const extensionControl = registerEmbeddingExtension(
    sqlite3,
    session?.infer,
    session ? { identity: session.identity, timeoutMs: readyOptions?.sqlTimeoutMs, information: session.information } : undefined
  );

  let closed = false;
  /**
   * 処理名: 埋め込みリソース完全クローズ
   * 処理概要: 拡張、推論セッション、OPFS Poolを順次解放する。
   * 実装理由: 終了時に全内部リソースを安全に破棄するため。
   * @returns 完了Promise。
   */
  const closeEmbedding = async (): Promise<void> => {
    if (closed) return;
    await extensionControl.close();
    if (session) {
      await session.close();
    }
    if (activePool && typeof activePool.pauseVfs === "function") {
      activePool.pauseVfs();
    }
    closed = true;
  };
  const embeddingControl = {
    close: closeEmbedding
  };

  return Object.assign(sqlite3, {
    embedding: embeddingControl
  });
}
