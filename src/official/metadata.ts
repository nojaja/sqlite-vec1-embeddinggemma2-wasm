import { VectorError } from "../errors";

/**
 * 処理名: モデル識別子インターフェース
 */
export interface ModelIdentity {
  modelId: string;
  revision: string;
  fingerprint: string;
  profile: string;
  backend?: string;
  runtimeGeneration?: number;
}

/**
 * 処理名: 公式保存メタデータレコード型
 */
export interface OfficialMetadataRecord {
  productVersion: "0.0.3";
  modelId: string;
  revision: string;
  fingerprint: string;
  profile: string;
  dimension: number;
  dtype: string;
}

/**
 * 処理名: 公式保存メタデータ DDL 定数
 */
export const OFFICIAL_METADATA_DDL = "CREATE TABLE _svw_meta(id INTEGER PRIMARY KEY CHECK(id=1), metadata TEXT NOT NULL) STRICT";

/**
 * 処理名: 公式保存メタデータレコード生成
 * 処理概要: identity から 7 つの厳格なキーを持つ保存メタデータオブジェクトを生成する。
 * 実装理由: backend や runtimeGeneration 等の非保存項目を除外し、固定スキーマで保存するため。
 * @param identity - モデル識別情報。
 * @returns 7項目の OfficialMetadataRecord。
 */
export function officialMetadataRecord(identity: ModelIdentity): OfficialMetadataRecord {
  return {
    productVersion: "0.0.3",
    modelId: identity.modelId,
    revision: identity.revision,
    fingerprint: identity.fingerprint,
    profile: identity.profile,
    dimension: 768,
    dtype: "q4"
  };
}

/**
 * 処理名: 公式保存メタデータ検証
 * 処理概要: DB から読み取られたメタデータが現在の identity および固定規約（productVersion: 0.0.3, dimension: 768, dtype: q4）と一致するか検証する。
 * 実装理由: モデル空間の混在や未対応バージョンのデータベースアクセスを防止するため。
 * @param actual - 実際のメタデータオブジェクト。
 * @param identity - 期待するモデル識別情報。
 */
export function validateOfficialMetadata(
  actual: unknown,
  identity: ModelIdentity
): void {
  if (!actual || typeof actual !== "object") {
    throw new VectorError("E_MODEL_MISMATCH");
  }

  const rec = actual as Record<string, unknown>;
  const keys = Object.keys(rec);
  if (keys.length !== 7) {
    throw new VectorError("E_MODEL_MISMATCH");
  }

  if (
    rec.productVersion !== "0.0.3" ||
    rec.modelId !== identity.modelId ||
    rec.revision !== identity.revision ||
    rec.fingerprint !== identity.fingerprint ||
    rec.profile !== identity.profile ||
    rec.dimension !== 768 ||
    rec.dtype !== "q4"
  ) {
    throw new VectorError("E_MODEL_MISMATCH");
  }
}

/**
 * 処理名: 公式メタデータ初期化およびバインド
 * 処理概要: 新規空 DB の場合は _svw_meta テーブルを作成してメタデータを記録し、既存 DB の場合はメタデータを検証する。
 * @param sqlite3 - SQLite3 公式静的インターフェース。
 * @param db - 対象データベース接続。
 * @param identity - モデル識別情報。
 */
export function initializeOfficialMetadata(
  sqlite3: any,
  db: any,
  identity: ModelIdentity
): void {
  const metaTableCount = db.selectValue("SELECT count(*) FROM sqlite_schema WHERE type='table' AND name='_svw_meta'");
  if (metaTableCount === 0) {
    // テーブルが存在しない場合: 既存テーブルの有無を確認
    const userTableCount = db.selectValue("SELECT count(*) FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'");
    if (userTableCount > 0) {
      throw new VectorError("E_MODEL_UNBOUND");
    }

    // 新規空 DB のバインド
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(OFFICIAL_METADATA_DDL);
      const recordJson = JSON.stringify(officialMetadataRecord(identity));
      const stmt = db.prepare("INSERT INTO _svw_meta(id, metadata) VALUES(1, ?)");
      try {
        stmt.bind(1, recordJson);
        stmt.step();
      } finally {
        stmt.finalize();
      }
      db.exec("COMMIT");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // ロールバックエラーは無視
      }
      throw err;
    }
  } else {
    // 既存テーブルの検証
    const schemaSql = db.selectValue("SELECT sql FROM sqlite_schema WHERE type='table' AND name='_svw_meta'");
    if (schemaSql !== OFFICIAL_METADATA_DDL) {
      throw new VectorError("E_MODEL_MISMATCH");
    }

    const rowCount = db.selectValue("SELECT count(*) FROM _svw_meta");
    if (rowCount !== 1) {
      throw new VectorError("E_MODEL_MISMATCH");
    }

    const metaJson = db.selectValue("SELECT metadata FROM _svw_meta WHERE id=1");
    if (typeof metaJson !== "string") {
      throw new VectorError("E_MODEL_MISMATCH");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(metaJson);
    } catch {
      throw new VectorError("E_MODEL_MISMATCH");
    }

    validateOfficialMetadata(parsed, identity);
  }
}

/**
 * 処理名: 予約領域保護マネージャー
 * 処理概要: authorizer を設定し、_svw_ 接頭辞テーブルへの書き込みや writable_schema を遮断しつつ利用者の authorizer を合成する。
 * 実装理由: ユーザー SQL によるメタデータ改変・破壊を未然に防止し、ユーザー指定の認可ハンドラと共存させるため。
 */
export class OfficialMetadataProtection {
  private readonly sqlite3: any;
  private readonly origSetAuthorizer: any;
  private readonly userAuthorizers = new WeakMap<any, { auth: any; pUser: any }>();
  private isDisposed = false;

  constructor(sqlite3: any) {
    this.sqlite3 = sqlite3;
    const capi = sqlite3.capi;
    this.origSetAuthorizer = capi.sqlite3_set_authorizer;

    const self = this;
    capi.sqlite3_set_authorizer = (pDb: any, xAuth: any, pUserData: any) => {
      const dbObj = (pDb && typeof pDb === "object" && pDb.pointer) ? pDb : null;
      if (dbObj) {
        self.userAuthorizers.set(dbObj, { auth: xAuth, pUser: pUserData });
        return self.origSetAuthorizer.call(capi, dbObj.pointer, self.createCompositeAuthorizer(xAuth, pUserData), 0);
      }
      return self.origSetAuthorizer.call(capi, pDb, self.createCompositeAuthorizer(xAuth, pUserData), pUserData);
    };
  }

  private createCompositeAuthorizer(userAuth: any, pUser: any) {
    const capi = this.sqlite3.capi;
    return (pUserData: any, actionCode: any, p1: any, p2: any, dbName: any, triggerName: any) => {
      const target = typeof p1 === "string" ? p1 : (p1 ? this.sqlite3.wasm.cstrToJs(p1) : "");

      // 1. _svw_ テーブルへの書き込み・スキーマ変更を禁止
      if (typeof target === "string" && target.startsWith("_svw_")) {
        if (
          actionCode === 23 ||
          actionCode === 9 ||
          actionCode === 11 ||
          actionCode === 18 ||
          actionCode === 26 ||
          actionCode === capi.SQLITE_UPDATE ||
          actionCode === capi.SQLITE_DELETE ||
          actionCode === capi.SQLITE_DROP_TABLE ||
          actionCode === capi.SQLITE_INSERT ||
          actionCode === capi.SQLITE_ALTER_TABLE
        ) {
          return capi.SQLITE_DENY;
        }
      }

      // 2. PRAGMA writable_schema の禁止
      if (
        (actionCode === 19 || actionCode === capi.SQLITE_PRAGMA) &&
        typeof target === "string" &&
        target.toLowerCase() === "writable_schema"
      ) {
        return capi.SQLITE_DENY;
      }

      // 3. 利用者 authorizer があれば実行
      if (typeof userAuth === "function") {
        return userAuth(pUser ?? pUserData, actionCode, p1, p2, dbName, triggerName);
      }

      return capi.SQLITE_OK;
    };
  }

  public observe(db: any): void {
    const pDb = db.pointer ?? db;
    const auth = this.createCompositeAuthorizer(null, 0);
    this.origSetAuthorizer.call(this.sqlite3.capi, pDb, auth, 0);
  }

  public close(db: any): void {
    this.userAuthorizers.delete(db);
  }

  public dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    this.sqlite3.capi.sqlite3_set_authorizer = this.origSetAuthorizer;
  }
}
