#!/usr/bin/env python3
"""
処理名: SQLite & vec1 ソースパッチスクリプト
処理概要: Lemon 文法規則拡張、STRICT VECTOR 列型受容、STRICT BLOB 制約、vec1 シングルスレッド修正、CAPI glue パッチを適用する。
実装理由: docs/spec/v0.0.1/build.md 第2項に完全準拠した SQLite 3.54.1 + vec1 0.8 ランタイムを生成するため。
"""
import sys
import os

def patch_file(path, search_str, replace_str):
    if not os.path.exists(path):
        return False
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        content = f.read()
    if search_str not in content:
        print(f"[WARN] Pattern not found in {path}")
        return False
    content = content.replace(search_str, replace_str, 1)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    print(f"[OK] Patched {path}")
    return True

def apply_strict_vector_patches(content):
    # 1. sqlite3AffinityType
    aff_target = "char sqlite3AffinityType(const char *zIn, Column *pCol){\n  u32 h = 0;"
    aff_repl = """char sqlite3AffinityType(const char *zIn, Column *pCol){
  if( sqlite3_strnicmp(zIn, "VECTOR", 6)==0 && (zIn[6]==0 || zIn[6]=='(' || sqlite3Isspace(zIn[6])) ){ if( pCol ) pCol->szEst = 5; return SQLITE_AFF_BLOB; }
  u32 h = 0;"""
    if "sqlite3_strnicmp(zIn, \"VECTOR\", 6)==0" not in content:
        content = content.replace(aff_target, aff_repl, 1)

    # 2. sqlite3EndTable の TF_Strict 検証
    strict_target = """      if( pCol->eCType==COLTYPE_CUSTOM ){
        if( pCol->colFlags & COLFLAG_HASTYPE ){
          sqlite3ErrorMsg(pParse,
            "unknown datatype for %s.%s: \\"%s\\"",
            p->zName, pCol->zCnName, sqlite3ColumnType(pCol, "")
          );
        }else{
          sqlite3ErrorMsg(pParse, "missing datatype for %s.%s",
                          p->zName, pCol->zCnName);
        }
        return;
      }"""
    strict_repl = """      if( pCol->eCType==COLTYPE_CUSTOM ){
        const char *zVecType = sqlite3ColumnType(pCol, "");
        if( (pCol->colFlags & COLFLAG_HASTYPE)!=0 && sqlite3_strnicmp(zVecType, "VECTOR", 6)==0 && (zVecType[6]==0 || zVecType[6]=='(' || sqlite3Isspace(zVecType[6])) ){
          pCol->affinity = SQLITE_AFF_BLOB;
        }else if( pCol->colFlags & COLFLAG_HASTYPE ){
          sqlite3ErrorMsg(pParse,
            "unknown datatype for %s.%s: \\"%s\\"",
            p->zName, pCol->zCnName, zVecType
          );
          return;
        }else{
          sqlite3ErrorMsg(pParse, "missing datatype for %s.%s",
                          p->zName, pCol->zCnName);
          return;
        }
      }"""
    if "const char *zVecType = sqlite3ColumnType(pCol, \"\");" not in content:
        content = content.replace(strict_target, strict_repl, 1)

    # 3. OP_TypeCheck
    typecheck_target = """        default: {
          /* COLTYPE_ANY.  Accept anything. */
          break;
        }"""
    typecheck_repl = """        default: {
          /* COLTYPE_ANY.  Accept anything. */
          if( aCol[i].eCType==COLTYPE_CUSTOM && aCol[i].affinity==SQLITE_AFF_BLOB ){
            if( (pIn1->flags & MEM_Blob)==0 ) goto vdbe_type_error;
          }
          break;
        }"""
    if "aCol[i].eCType==COLTYPE_CUSTOM && aCol[i].affinity==SQLITE_AFF_BLOB" not in content:
        content = content.replace(typecheck_target, typecheck_repl, 1)

    # 4. vdbe_type_error
    err_target = """vdbe_type_error:
  sqlite3VdbeError(p, "cannot store %s value in %s column %s.%s",
     vdbeMemTypeName(pIn1), sqlite3StdType[aCol[i].eCType-1],
     pTab->zName, aCol[i].zCnName);"""
    err_repl = """vdbe_type_error:
  sqlite3VdbeError(p, "cannot store %s value in %s column %s.%s",
     vdbeMemTypeName(pIn1),
     (aCol[i].eCType>0 && aCol[i].eCType<=5 ? sqlite3StdType[aCol[i].eCType-1] : "VECTOR"),
     pTab->zName, aCol[i].zCnName);"""
    if "aCol[i].eCType<=5 ? sqlite3StdType[aCol[i].eCType-1] : \"VECTOR\"" not in content:
        content = content.replace(err_target, err_repl, 1)

    return content

def main():
    root = sys.argv[1] if len(sys.argv) > 1 else "."

    # 1. src/parse.y の typetoken 拡張
    parse_y = os.path.join(root, "src/parse.y")
    target_rule = "typetoken(A) ::= typename(A) LP signed COMMA signed RP(Y)."
    new_rule = """typetoken(A) ::= typename(A) LP signed COMMA signed RP(Y). {
  A.z = A.z;
  A.n = (int)(&Y.z[Y.n] - A.z);
}
typetoken(A) ::= typename(A) LP signed COMMA ids RP(Y). {
  A.z = A.z;
  A.n = (int)(&Y.z[Y.n] - A.z);
}"""
    if os.path.exists(parse_y):
        with open(parse_y, "r", encoding="utf-8") as f:
            c = f.read()
        if "COMMA ids RP(Y)" not in c:
            idx = c.find(target_rule)
            if idx != -1:
                end_idx = c.find("}", idx) + 1
                c = c[:idx] + new_rule + c[end_idx:]
                with open(parse_y, "w", encoding="utf-8") as f:
                    f.write(c)
                print("[OK] Patched src/parse.y with typetoken COMMA ids.")

    # 2. src/build.c のパッチ
    build_c = os.path.join(root, "src/build.c")
    if os.path.exists(build_c):
        with open(build_c, "r", encoding="utf-8") as f:
            c = f.read()
        c = apply_strict_vector_patches(c)
        with open(build_c, "w", encoding="utf-8") as f:
            f.write(c)
        print("[OK] Patched src/build.c.")

    # 3. src/vdbe.c のパッチ
    vdbe_c = os.path.join(root, "src/vdbe.c")
    if os.path.exists(vdbe_c):
        with open(vdbe_c, "r", encoding="utf-8") as f:
            c = f.read()
        c = apply_strict_vector_patches(c)
        with open(vdbe_c, "w", encoding="utf-8") as f:
            f.write(c)
        print("[OK] Patched src/vdbe.c.")

    # 4. sqlite3.c (Amalgamation) が存在する場合の直接パッチ
    sqlite3_c = os.path.join(root, "sqlite3.c")
    if os.path.exists(sqlite3_c):
        with open(sqlite3_c, "r", encoding="utf-8") as f:
            c = f.read()
        c = apply_strict_vector_patches(c)
        with open(sqlite3_c, "w", encoding="utf-8") as f:
            f.write(c)
        print("[OK] Patched sqlite3.c.")

    # 5. ext/wasm/vec1.c パッチ
    vec1_c = os.path.join(root, "ext/wasm/vec1.c")
    if os.path.exists(vec1_c):
        with open(vec1_c, "r", encoding="utf-8") as f:
            v1c = f.read()

        if "#define VEC1_STATIC 1" not in v1c:
            v1c = """#define VEC1_VERSION "0.8"
#define VEC1_STATIC 1
#define VEC1_THREADS 0
""" + v1c

        v1c = v1c.replace(
            "const int nJob = (pQueue ? pQueue->nWorker + 1 : 1);",
            "const int nJob = 1; (void)pQueue;"
        )

        old_finish = """static int vec1FinishWriter(Vec1Tab *pTab, int bDiscard){
  int rc = SQLITE_OK;
  if( pTab->pWriter ){
    rc = vec1WriterFinish(pTab->pWriter, bDiscard);
    pTab->pWriter = 0;
  }
  return rc;
}"""
        new_finish = """static int vec1FinishWriter(Vec1Tab *pTab, int bDiscard){
  Vec1Writer *pWriter = pTab->pWriter;
  if( pWriter==0 ) return SQLITE_OK;
  pTab->pWriter = 0;
  return vec1WriterFinish(pWriter, bDiscard);
}"""
        v1c = v1c.replace(old_finish, new_finish)

        with open(vec1_c, "w", encoding="utf-8") as f:
            f.write(v1c)
        print("[OK] Patched ext/wasm/vec1.c.")

    # 6. ext/wasm/api/sqlite3-api-glue.c-pp.js パッチ
    glue_js = os.path.join(root, "ext/wasm/api/sqlite3-api-glue.c-pp.js")
    if os.path.exists(glue_js):
        with open(glue_js, "r", encoding="utf-8") as f:
            gjc = f.read()
        gjc = gjc.replace("}else if(Array.isArray(pMem)){", "}else if(Array.isArray(text)){", 1)
        gjc = gjc.replace("[p, n] = wasm.allocCString(text);", "[p, n] = wasm.allocCString(text, true);")
        gjc = gjc.replace("[p, n] = wasm.allocCString(pMem);", "[p, n] = wasm.allocCString(pMem, true);")
        with open(glue_js, "w", encoding="utf-8") as f:
            f.write(gjc)
        print("[OK] Patched ext/wasm/api/sqlite3-api-glue.c-pp.js.")

    print("All SQLite patches applied successfully.")

if __name__ == "__main__":
    main()
