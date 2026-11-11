/**
 * 処理名: SQLite WASM 追加初期化フック
 * 処理概要: vec1 拡張モジュールおよび C 言語版 DISTANCE UDF を全データベース接続へ自動登録する。
 * 実装理由: WebAssembly 実行環境において追加の CAPI 呼び出しなしでセマンティック検索機能を即時利用可能にするため。
 */
#include "sqlite3.h"
#include <math.h>
#include <string.h>

#if defined(__clang__)
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wtypedef-redefinition"
#endif

/* vec1 ソースを静的結合 */
#include "vec1.c"

#if defined(__clang__)
#pragma clang diagnostic pop
#endif

/**
 * 処理名: C 言語版 DISTANCE スカラー SQL 関数
 * 処理概要: 2つの同一次元 Float32 BLOB 間のコサイン距離 (1.0 - cosine_similarity) を計算する。
 * @param context - SQLite 関数コンテキスト。
 * @param argc - 引数の数 (2)。
 * @param argv - 引数値配列 (BLOB, BLOB)。
 */
static void distanceFunc(sqlite3_context *context, int argc, sqlite3_value **argv) {
  if (argc != 2) {
    sqlite3_result_error(context, "E_INPUT", -1);
    return;
  }

  if (sqlite3_value_type(argv[0]) == SQLITE_NULL || sqlite3_value_type(argv[1]) == SQLITE_NULL) {
    sqlite3_result_null(context);
    return;
  }

  if (sqlite3_value_type(argv[0]) != SQLITE_BLOB || sqlite3_value_type(argv[1]) != SQLITE_BLOB) {
    sqlite3_result_error(context, "E_INPUT", -1);
    return;
  }

  int bytes0 = sqlite3_value_bytes(argv[0]);
  int bytes1 = sqlite3_value_bytes(argv[1]);

  if (bytes0 != bytes1 || bytes0 <= 0 || (bytes0 % 4) != 0) {
    sqlite3_result_error(context, "E_INPUT", -1);
    return;
  }

  int dim = bytes0 / 4;
  const float *v0 = (const float *)sqlite3_value_blob(argv[0]);
  const float *v1 = (const float *)sqlite3_value_blob(argv[1]);

  double dot = 0.0;
  double norm0Sq = 0.0;
  double norm1Sq = 0.0;

  for (int i = 0; i < dim; i++) {
    float x = v0[i];
    float y = v1[i];
    if (!isfinite(x) || !isfinite(y)) {
      sqlite3_result_error(context, "E_INPUT", -1);
      return;
    }
    double dx = (double)x;
    double dy = (double)y;
    dot += dx * dy;
    norm0Sq += dx * dx;
    norm1Sq += dy * dy;
  }

  if (norm0Sq <= 0.0 || norm1Sq <= 0.0) {
    sqlite3_result_error(context, "E_INPUT", -1);
    return;
  }

  double norm0 = sqrt(norm0Sq);
  double norm1 = sqrt(norm1Sq);
  double sim = dot / (norm0 * norm1);

  if (sim > 1.0) sim = 1.0;
  if (sim < -1.0) sim = -1.0;

  double dist = 1.0 - sim;
  if (dist < 0.0) dist = 0.0;

  sqlite3_result_double(context, dist);
}

/**
 * 処理名: 接続自動拡張初期化コールバック
 * 処理概要: 新規接続オープン時に vec1 モジュールおよび DISTANCE 関数を登録する。
 */
static int autoExtensionCallback(sqlite3 *db, char **pzErrMsg, const sqlite3_api_routines *pApi) {
  /* vec1 登録 (sqlite3_extension_init) */
  int rc = sqlite3_extension_init(db, pzErrMsg, pApi);
  if (rc != SQLITE_OK) return rc;

  /* DISTANCE(left, right) 関数登録 (UTF-8, DETERMINISTIC, INNOCUOUS) */
  rc = sqlite3_create_function_v2(
    db,
    "DISTANCE",
    2,
    SQLITE_UTF8 | SQLITE_DETERMINISTIC | SQLITE_INNOCUOUS,
    0,
    distanceFunc,
    0,
    0,
    0
  );
  return rc;
}

/**
 * 処理名: SQLite WASM エクストラ初期化エントリポイント
 * 処理概要: SQLite Wasm モジュールロード時に呼ばれ、auto_extension を設定する。
 * @param z - 任意初期化文字列 (通常は NULL)。
 * @returns SQLITE_OK (0)
 */
int sqlite3_wasm_extra_init(const char *z) {
  (void)z;
  return sqlite3_auto_extension((void(*)(void))autoExtensionCallback);
}
