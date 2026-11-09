# SQLite vec1 / EmbeddingGemma 2 Wasm

SQLite 3.54.1、公式 vec1 0.8、および EmbeddingGemma 2 を統合する TypeScript ライブラリです。
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

本プロジェクトで必要な資材（公式 SQLite 3.54.1 + vec1 0.8 組み込み Wasm、EmbeddingGemma 2 モデル資材、ビルド・検証用入力アーカイブなど）の一覧、入手先 URL、および保存先ディレクトリの詳細は [`docs/spec/v0.0.1/assets.md`](docs/spec/v0.0.1/assets.md) に集約されています。

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
