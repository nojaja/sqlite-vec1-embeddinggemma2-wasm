import { VectorError } from "../errors";
import { embeddingSqlValue } from "./functions";
import { StatementLifecycle } from "../sqlite/statement-lifecycle";
import { officialMetadataRecord, validateOfficialMetadata } from "./metadata";
import type { EmbeddingControl, Sqlite3Static } from "./types";
import type { EmbeddingCacheIdentity, EmbeddingInference } from "../inference/statement-embedding-cache";

export interface RegistrationOptions {
  identity?: EmbeddingCacheIdentity;
  timeoutMs?: number;
  information?: Record<string, unknown>;
  check?: () => void;
}

const DEFAULT_IDENTITY: EmbeddingCacheIdentity = {
  modelId: "embeddinggemma-2",
  revision: "daa72c51243991dfcaf9f9137d2c573d8f7790c0",
  fingerprint: "5e730f96377d880c7ca94c9ddc9cd5f600e5237e106f5e4dc7d9448140026ac7",
  profile: "embeddinggemma-2/q4/768",
  backend: "wasm",
  runtimeGeneration: 0
};

export function registerEmbeddingExtension(
  sqlite3: Sqlite3Static,
  infer?: EmbeddingInference,
  options: RegistrationOptions = {}
): EmbeddingControl {
  const openDatabases = new Set<any>();
  let functionCalls = 0;
  const identity = options.identity ?? DEFAULT_IDENTITY;
  const lifecycle = new StatementLifecycle(
    identity,
    options.timeoutMs ?? 120000,
    () => performance.now(),
    options.check
  );

  if (sqlite3.capi && typeof sqlite3.capi.sqlite3_trace_v2 === "function") {
    const origTrace = sqlite3.capi.sqlite3_trace_v2.bind(sqlite3.capi);
    sqlite3.capi.sqlite3_trace_v2 = (pDb: any, mask: any, cb: any, pApp?: any) => {
      return origTrace(pDb, mask, cb, pApp ?? 0);
    };
  }

  const userAuthorizers = new Map<any, { cb: any; pApp: any }>();
  let origSetAuthorizer: any = null;
  if (sqlite3.capi && typeof sqlite3.capi.sqlite3_set_authorizer === "function") {
    origSetAuthorizer = sqlite3.capi.sqlite3_set_authorizer.bind(sqlite3.capi);
    sqlite3.capi.sqlite3_set_authorizer = (dbTarget: any, userCb: any, pApp?: any) => {
      const pDb = typeof dbTarget?.pointer === "number" ? dbTarget.pointer : dbTarget;
      userAuthorizers.set(pDb, { cb: userCb, pApp });
      installCompositeAuthorizer(dbTarget);
      return sqlite3.capi.SQLITE_OK;
    };
  }

  function installCompositeAuthorizer(dbTarget: any) {
    if (!origSetAuthorizer) return;
    const pDb = typeof dbTarget?.pointer === "number" ? dbTarget.pointer : dbTarget;
    origSetAuthorizer(pDb, (_pApp: any, action: number, a1: any, a2: any, dbName: any, triggerName: any) => {
      const s1 = typeof a1 === "string" ? a1.toLowerCase() : "";
      const s2 = typeof a2 === "string" ? a2.toLowerCase() : "";
      if ((s1.includes("_svw_") || s2.includes("_svw_")) && action !== sqlite3.capi.SQLITE_READ) {
        return sqlite3.capi.SQLITE_DENY;
      }
      if (action === sqlite3.capi.SQLITE_PRAGMA && s1 === "writable_schema") {
        return sqlite3.capi.SQLITE_DENY;
      }
      const user = userAuthorizers.get(pDb) ?? userAuthorizers.get(dbTarget);
      if (user && typeof user.cb === "function") {
        return user.cb(user.pApp, action, a1, a2, dbName, triggerName);
      }
      return sqlite3.capi.SQLITE_OK;
    }, 0);
  }

  const userProgressHandlers = new Map<number, { nOp: number; cb: any; pApp: any }>();
  let origProgressHandler: any = null;

  interface DbExecutionState {
    timedOut: boolean;
    cancelled: boolean;
    userCancelled: boolean;
  }
  const dbStates = new Map<number, DbExecutionState>();

  function getDbState(pDb: number): DbExecutionState {
    let state = dbStates.get(pDb);
    if (!state) {
      state = { timedOut: false, cancelled: false, userCancelled: false };
      dbStates.set(pDb, state);
    }
    return state;
  }

  function installCompositeProgressHandler(pDb: number) {
    if (!origProgressHandler) return;
    const user = userProgressHandlers.get(pDb);
    const internalN = 50;
    const effectiveN = (user && user.nOp > 0) ? Math.min(user.nOp, internalN) : internalN;

    let opCounter = 0;
    origProgressHandler(pDb, effectiveN, (pApp: any) => {
      const state = getDbState(pDb);
      opCounter += effectiveN;

      if (lifecycle.hasActiveStep()) {
        try {
          const current = lifecycle.current();
          if (performance.now() >= current.deadline) {
            state.timedOut = true;
            return 1;
          }
          if (current.cancelled || Atomics.load(new Int32Array(current.cancellationBuffer), 0) !== 0) {
            state.cancelled = true;
            return 1;
          }
        } catch {
          state.timedOut = true;
          return 1;
        }
      }

      if (user && user.nOp > 0 && typeof user.cb === "function") {
        if (opCounter >= user.nOp) {
          opCounter = 0;
          try {
            const res = user.cb(user.pApp);
            if (res !== 0 && res !== undefined && res !== null && res !== false) {
              state.userCancelled = true;
              return 1;
            }
          } catch {
            state.userCancelled = true;
            return 1;
          }
        }
      }

      return 0;
    }, 0);
  }

  if (sqlite3.capi && typeof sqlite3.capi.sqlite3_progress_handler === "function") {
    origProgressHandler = sqlite3.capi.sqlite3_progress_handler.bind(sqlite3.capi);
    sqlite3.capi.sqlite3_progress_handler = (dbTarget: any, nOp: number, cb: any, pApp?: any) => {
      const pDb = typeof dbTarget?.pointer === "number" ? dbTarget.pointer : dbTarget;
      if (nOp > 0 && typeof cb === "function") {
        userProgressHandlers.set(pDb, { nOp, cb, pApp: pApp ?? 0 });
      } else {
        userProgressHandlers.delete(pDb);
      }
      installCompositeProgressHandler(pDb);
    };
  }

  let origStep: any = null;
  let origReset: any = null;
  let origFinalize: any = null;

  if (sqlite3.capi && typeof sqlite3.capi.sqlite3_step === "function") {
    origStep = sqlite3.capi.sqlite3_step.bind(sqlite3.capi);
    origReset = sqlite3.capi.sqlite3_reset.bind(sqlite3.capi);
    origFinalize = sqlite3.capi.sqlite3_finalize.bind(sqlite3.capi);

    sqlite3.capi.sqlite3_step = (pStmt: number) => {
      const pDb = sqlite3.capi.sqlite3_db_handle(pStmt);
      lifecycle.enter(pDb, pStmt);
      let rc = 1;
      let stepErr: any = null;
      try {
        rc = origStep(pStmt);
      } catch (err) {
        stepErr = err;
      }
      const state = dbStates.get(pDb);
      if (state?.timedOut) {
        state.timedOut = false;
        lifecycle.leave(pStmt, 1);
        throw new VectorError("E_TIMEOUT");
      }
      if (state?.cancelled || state?.userCancelled) {
        state.cancelled = false;
        state.userCancelled = false;
        lifecycle.leave(pStmt, 1);
        throw new VectorError("E_CANCELLED");
      }
      if (stepErr) {
        lifecycle.leave(pStmt, 1);
        throw stepErr;
      }
      try {
        lifecycle.leave(pStmt, rc);
      } catch (err) {
        throw err;
      }
      return rc;
    };

    sqlite3.capi.sqlite3_reset = (pStmt: number) => {
      lifecycle.reset(pStmt);
      return origReset(pStmt);
    };

    sqlite3.capi.sqlite3_finalize = (pStmt: number) => {
      lifecycle.reset(pStmt);
      return origFinalize(pStmt);
    };
  }

  const origDB = sqlite3.oo1.DB;
  let dbCounter = 1;

  function registerFunctionsOnDb(db: any, _dbId: number) {
    function create(name: string, arity: number, fn: (...args: any[]) => any) {
      if (typeof db.createFunction === "function") {
        db.createFunction(name, (_pCtx: any, ...args: any[]) => fn(...args), { arity, directOnly: true });
      }
    }

    const getInfer = () => {
      if (!infer) return undefined;
      const current = lifecycle.hasActiveStep() ? lifecycle.current() : null;
      return current ? (req: any) => current.cache.resolve(req, infer) : infer;
    };

    create("embedding", 1, (text: any) => {
      functionCalls++;
      return embeddingSqlValue("embedding", [text], getInfer());
    });
    create("embedding", 2, (text: any, model: any) => {
      functionCalls++;
      return embeddingSqlValue("embedding", [text, model], getInfer());
    });
    create("embedding_query", 1, (text: any) => {
      functionCalls++;
      return embeddingSqlValue("embedding_query", [text], getInfer());
    });
    create("embedding_query", 2, (text: any, model: any) => {
      functionCalls++;
      return embeddingSqlValue("embedding_query", [text, model], getInfer());
    });
    create("gemma_embed_query", 1, (text: any) => {
      functionCalls++;
      return embeddingSqlValue("gemma_embed_query", [text], getInfer());
    });
    create("gemma_embed_query", 2, (text: any, title: any) => {
      functionCalls++;
      return embeddingSqlValue("gemma_embed_query", [text, title], getInfer());
    });
    create("gemma_embed_document", 1, (text: any) => {
      functionCalls++;
      return embeddingSqlValue("gemma_embed_document", [text], getInfer());
    });
    create("gemma_embed_document", 2, (text: any, title: any) => {
      functionCalls++;
      return embeddingSqlValue("gemma_embed_document", [text, title], getInfer());
    });
    create("gemma_embed_image", 2, (bytes: any, mime: any) => {
      functionCalls++;
      return embeddingSqlValue("gemma_embed_image", [bytes, mime], getInfer());
    });

    create("gemma_model_info", 0, () => {
      const stats = lifecycle.statistics();
      const ready = !!infer;
      const cacheObj = {
        hit: stats.hit,
        miss: stats.miss,
        eviction: stats.eviction,
        actualInference: stats.actualInference,
        entries: stats.entries,
        bytes: stats.bytes
      };
      const baseInfo: Record<string, unknown> = {
        ready,
        model: "embeddinggemma-2",
        functionCalls,
        cache: cacheObj,
        ...cacheObj
      };
      if (ready) {
        baseInfo.modelId = "google/embeddinggemma-2";
        baseInfo.revision = identity.revision;
        baseInfo.fingerprint = identity.fingerprint;
        baseInfo.dtype = "q4";
        baseInfo.dimension = 768;
        baseInfo.backend = identity.backend;
        baseInfo.profile = identity.profile;
        if (options.information) {
          Object.assign(baseInfo, options.information);
        }
      }
      return JSON.stringify(baseInfo);
    });

    create("DISTANCE", 2, (left: any, right: any) => {
      if (left === null || right === null) return null;
      if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array)) {
        throw new VectorError("E_INPUT");
      }
      if (left.byteLength !== 3072 || right.byteLength !== 3072) {
        throw new VectorError("E_INPUT");
      }
      const v1 = new DataView(left.buffer, left.byteOffset, left.byteLength);
      const v2 = new DataView(right.buffer, right.byteOffset, right.byteLength);
      let dot = 0;
      let s1 = 0;
      let s2 = 0;
      for (let i = 0; i < 768; i++) {
        const f1 = Number(v1.getFloat32(i * 4, true));
        const f2 = Number(v2.getFloat32(i * 4, true));
        if (!Number.isFinite(f1) || !Number.isFinite(f2)) {
          throw new VectorError("E_INPUT");
        }
        dot += f1 * f2;
        s1 += f1 * f1;
        s2 += f2 * f2;
      }
      const n1 = Math.sqrt(s1);
      const n2 = Math.sqrt(s2);
      if (!Number.isFinite(n1) || !Number.isFinite(n2) || n1 <= 0 || n2 <= 0) {
        throw new VectorError("E_INPUT");
      }
      const cos = dot / (n1 * n2);
      return Math.max(0, Math.min(2, 1 - cos));
    });

    // metadata
    if (infer) {
      try {
        const hasMeta = db.selectValue("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='_svw_meta'");
        if (!hasMeta) {
          const userTableCount = db.selectValue("SELECT count(*) FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'");
          if (Number(userTableCount) > 0) {
            throw new VectorError("E_MODEL_UNBOUND");
          }
          db.exec("CREATE TABLE _svw_meta(id INTEGER PRIMARY KEY CHECK(id=1), metadata TEXT NOT NULL) STRICT");
          const record = officialMetadataRecord(identity);
          db.exec({
            sql: "INSERT INTO _svw_meta(id, metadata) VALUES(1, ?)",
            bind: [JSON.stringify(record)]
          });
        } else {
          const raw = db.selectValue("SELECT metadata FROM _svw_meta WHERE id=1");
          if (!raw) throw new VectorError("E_MODEL_MISMATCH");
          const parsed = JSON.parse(String(raw));
          validateOfficialMetadata(parsed, identity);
        }
      } catch (e) {
        if (e instanceof VectorError) throw e;
      }
    }
    installCompositeAuthorizer(db);
  }

  function WrappedDB(this: any, ...args: any[]) {
    const db = new origDB(...args);
    const dbId = db.pointer ?? dbCounter++;
    openDatabases.add(db);

    const origClose = db.close.bind(db);
    db.close = () => {
      openDatabases.delete(db);
      lifecycle.close(db.pointer ?? dbId);
      return origClose();
    };

    try {
      registerFunctionsOnDb(db, dbId);
      if (typeof db.pointer === "number") {
        installCompositeProgressHandler(db.pointer);
      }
    } catch (err) {
      openDatabases.delete(db);
      try { origClose(); } catch {}
      throw err;
    }
    return db;
  }
  Object.setPrototypeOf(WrappedDB, origDB);
  WrappedDB.prototype = origDB.prototype;

  sqlite3.oo1.DB = WrappedDB as any;

  let closed = false;
  return {
    close: async (): Promise<void> => {
      if (closed) return;
      if (openDatabases.size > 0) {
        throw new VectorError("E_DB_IN_USE");
      }
      sqlite3.oo1.DB = origDB;
      if (origSetAuthorizer) sqlite3.capi.sqlite3_set_authorizer = origSetAuthorizer;
      if (origProgressHandler) sqlite3.capi.sqlite3_progress_handler = origProgressHandler;
      if (origStep) sqlite3.capi.sqlite3_step = origStep;
      if (origReset) sqlite3.capi.sqlite3_reset = origReset;
      if (origFinalize) sqlite3.capi.sqlite3_finalize = origFinalize;
      closed = true;
    }
  };
}
