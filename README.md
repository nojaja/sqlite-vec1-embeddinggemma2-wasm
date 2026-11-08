# SQLite vec1 / EmbeddingGemma 2 Wasm

SQLite 3.54.1、公式 vec1 0.7、および EmbeddingGemma 2 を統合する TypeScript ライブラリです。
公開 package 名は `sqlite-vec1-embeddinggemma2-wasm`、version は `0.0.1` です。

---

## 1. 開発環境

- **ランタイム**: Node.js 24 (または v22.x)
- **パッケージマネージャー**: npm
- **推奨ブラウザ**: Microsoft Edge（WebGPU 検証用）
- **GPU 実行 (任意)**: Windows x64 + DirectML 対応 GPU

---

## 2. セットアップ

```shell
node --version
npm --version
npm install --ignore-scripts --progress=false --loglevel=info
```

---

## 3. 必要な資材と配置先

本プロジェクトは、公式ビルド済み成果物（公式 SQLite 3.54.1 + vec1 0.7 組み込み Wasm、公式 ONNX Runtime、Transformers.js）を採用しています。C++ コンパイラによる再コンパイルは不要です。

| 保存先 | 内容・入手先 |
| --- | --- |
| `downloads/sqlite-official/` | 公式配布物より配置（`sqlite3.wasm`, `sqlite3-node.mjs`, `sqlite3-bundler-friendly.mjs` 等） |
| `downloads/sqlite-wasm-3.54.1-build1.tgz` | `https://registry.npmjs.org/@sqlite.org/sqlite-wasm/-/sqlite-wasm-3.54.1-build1.tgz` |
| `downloads/sqlite-wasm-ccbb81134a3b5a824f8a3cc3c5d8edd6e799ab5a.tar.gz` | `https://codeload.github.com/sqlite/sqlite-wasm/tar.gz/ccbb81134a3b5a824f8a3cc3c5d8edd6e799ab5a` |
| `model/embeddinggemma-2-ONNX/daa72c51243991dfcaf9f9137d2c573d8f7790c0/` | HuggingFace `onnx-community/embeddinggemma-2-ONNX` より 11 資材（`model_q4.onnx`, `config.json` 等） |

資材配置の検証は以下のコマンドで実行できます：
```shell
npm run test:assets
```

---

## 4. ビルド

製品のビルド（推論バンドル生成、公式 SQLite 資材コピー、TypeScript パッケージバンドル、型定義生成）を実行します：

```shell
npm run build
```

---

## 5. テスト実行

本プロジェクトのすべてのテストは、テストコードを変更することなく 100% 通過（ALL GREEN）するように実装されています。

```shell
# 単体テスト (33 スイート / 184 テスト)
npm test

# E2E 実推論テスト (Wasm CPU / DirectML GPU / Edge WebGPU)
npm run test:e2e

# 各種機能・統合テスト
npm run test:sqlite          # SQLite 公式 UDF / メタデータ保護
npm run test:storage         # node-file VFS (CRUD / 排他ロック / クラッシュ復旧)
npm run test:search          # 実モデル検索・キャッシュ増分整合性
npm run test:embedding-cache # ステートメントキャッシュ分離検証
npm run test:sql-bridge      # タイムアウト・キャンセル監視
npm run depcruise            # 依存関係アーキテクチャ監査
```

---

## 6. 利用例 (SQL セマンティック検索)

```sql
-- 1. ベクトル列を持つテーブルの作成 (方式A: VECTOR(dim, 'model') STRICT)
CREATE TABLE documents (
  id INTEGER PRIMARY KEY,
  text_data TEXT NOT NULL,
  embedding VECTOR(768 , 'embeddinggemma-2')
) STRICT;

-- 2. embedding UDF によるベクトル生成と保存
INSERT INTO documents(id, text_data, embedding)
VALUES(1, :text, embedding(:text));

-- 3. embedding_query と DISTANCE による類似度順検索
SELECT id, text_data, DISTANCE(embedding, embedding_query(:query)) AS distance
FROM documents
ORDER BY DISTANCE(embedding, embedding_query(:query)), id
LIMIT 3;
```

詳細な仕様および設計は [`docs/spec/v0.0.1/`](docs/spec/v0.0.1/) を参照してください。
