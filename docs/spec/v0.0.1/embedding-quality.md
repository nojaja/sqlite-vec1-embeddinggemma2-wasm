# 埋め込み品質検証手順 (G03 Quality Gate)

本仕様書は、`fixtures/embedding-quality/manifest.json` および比較ベクトル（元モデル、ONNX FP32、Q4量子化モデル）の準備手順、マニフェスト定義、ならびにG03品質検証ゲートの実行・判定基準について規定する。

---

## 1. 概要と評価体系

モデル変換（ONNX化）や量子化（INT4/Q4）によって生じる埋め込み精度の劣化を定量的に検知するため、同一入力に対して3系列のベクトルを生成し、コサイン類似度により評価する。

```
[ 入力フィクスチャ ]
   ├── Text (100〜120件)
   └── Image (32件)
          │
          ├──> ① 元モデル (PyTorch FP32/BF16) ────────┐ (モデル vs 変換)
          │                                            ├── 変換誤差の検証
          ├──> ② ONNX FP32 変換モデル ───────────────┼── (平均 ≧ 0.99, 各件 ≧ 0.98)
          │                                            │
          └──> ③ Q4 量子化モデル (Wasm / DirectML) ───┴── 量子化誤差の検証
                                                           (Q4 vs 変換: Text平均 ≧ 0.98, 各件 ≧ 0.90 /
                                                                        Image平均 ≧ 0.96, 各件 ≧ 0.90)
```

### 1.1 比較対象の3系列ベクトル
すべてのベクトルは **768次元、Little-Endian、単精度浮動小数点数（Float32Array = 3,072バイト）** の生バイナリ形式とする。

1. **元モデル参照ベクトル (`modelReferenceVector`)**:
   - Hugging Face / Google 公式の元モデル（PyTorch / Transformers）が出力した参照埋め込み。
2. **ONNX変換参照ベクトル (`conversionVector`)**:
   - ONNX FP32 変換済みモデルが出力した参照埋め込み。変換自体の精度損失を測る基準点。
3. **Q4量子化ベクトル (`q4Vector`)**:
   - 本パッケージで配布・実行する INT4 量子化モデル（ONNX Runtime / WASM / DirectML）が出力した埋め込み。

### 1.2 合格判定閾値 (Cosine Similarity)
| 比較対象 | モダリティ | 平均コサイン (mean) | 個別最小コサイン (each) | 目的 |
| :--- | :---: | :---: | :---: | :--- |
| **モデル参照 vs ONNX FP32変換** | Text | **≧ 0.99** | **≧ 0.98** | ONNX変換時のグラフ変形・演算誤差の検出 |
| | Image | **≧ 0.99** | **≧ 0.98** | ビジョングラフ・前処理（リサイズ/正規化）誤差の検出 |
| **Q4量子化 vs ONNX FP32変換** | Text | **≧ 0.98** | **≧ 0.90** | INT4重み量子化によるテキスト意味損失の検出 |
| | Image | **≧ 0.96** | **≧ 0.90** | INT4重み量子化による画像埋め込み損失の検出 |

> **注意**: 平均値だけでなく `each`（個別最小値）を設けることで、一部の単語や画像で極端なコサイン低下が起きる局所的な劣化を見逃さない設計とする。

---

## 2. ディレクトリ構造とマニフェスト仕様

### 2.1 ディレクトリ配置 (`fixtures/embedding-quality/`)
```text
fixtures/embedding-quality/
├── manifest.json                  # G03正準マニフェスト（全fixture定義と参照メタデータ）
├── source/
│   ├── source-manifest.json       # 入力テキスト・画像一覧（実推論用）
│   └── images/                    # 32x32 PNG 画像群 (image-001.png 〜 image-032.png)
└── vectors/
    ├── model/                     # 元モデル推論ベクトル (*.bin, 3,072 bytes)
    ├── conversion/                # ONNX FP32推論ベクトル (*.bin, 3,072 bytes)
    └── q4/                        # Q4推論ベクトル (*.bin, 3,072 bytes)
```

### 2.2 `manifest.json` スキーマ仕様
```json
{
  "schemaVersion": 1,
  "modelReference": {
    "modelId": "google/embeddinggemma-2-27b-it",
    "revision": "5e730f96377d880c7ca94c9ddc9cd5f600e5237e106f5e4dc7d9448140026ac7",
    "precision": "fp32",
    "tool": "transformers",
    "toolVersion": "4.49.0"
  },
  "conversionReference": {
    "modelId": "onnx-community/embeddinggemma-2-27b-ONNX",
    "revision": "daa72c51243991dfcaf9f9137d2c573d8f7790c0",
    "precision": "fp32",
    "tool": "onnxruntime",
    "toolVersion": "1.21.0"
  },
  "fixtures": [
    {
      "id": "text-001",
      "modality": "text",
      "q4Vector": "vectors/q4/text-001.bin",
      "conversionVector": "vectors/conversion/text-001.bin",
      "modelReferenceVector": "vectors/model/text-001.bin"
    },
    {
      "id": "image-001",
      "modality": "image",
      "q4Vector": "vectors/q4/image-001.bin",
      "conversionVector": "vectors/conversion/image-001.bin",
      "modelReferenceVector": "vectors/model/image-001.bin",
      "source": "self-generated:g03-fixture-generator-v1",
      "license": "CC0-1.0",
      "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    }
  ]
}
```

- `schemaVersion`: 必ず `1`。
- `modelReference` / `conversionReference`:
  - `revision`: 40桁の小文字hex（Gitコミットハッシュ）。
  - `precision`: `modelReference` は `"fp32"` または `"bf16"`、`conversionReference` は `"fp32"` 必須。
- `fixtures`:
  - `text` 件数は **100件以上**（通常120件）。
  - `image` 件数は **32件以上**。
  - 画像エントリには `source`、`license`、`sha256`（64桁hex）が必須。

---

## 3. ベクトル準備の完全手順

ベクトル生成は以下の4段階で実施する。

```
Step 1: 入力フィクスチャ生成 (Text 120件 / PNG 32件)
   ↓
Step 2: 固定Pythonランタイムおよびモデル資材の準備
   ↓
Step 3: 各モデルによる推論実行と3072バイトLEバイナリ書き出し
   ↓
Step 4: manifest.jsonの生成とダイジェスト検証
```

### Step 1: 入力フィクスチャの生成 (`scripts/quality/g03-fixtures.ts`)
1. **テキスト生成**:
   - `multilingual`（日英独仏中等）、`code`（SQL/TypeScript/Python）、`search`（短文・長文検索クエリ）の3分類からなる計120件の決定論的テキストを生成。
2. **画像生成**:
   - 32x32解像度のPNG画像32件をプログラムで決定論的に生成（幾何学模様、グラデーション、単色、エッジパターン等）。
   - ライセンスを `CC0-1.0`、出典を `self-generated:g03-fixture-generator-v1` と定義し、各PNGファイルのSHA-256を記録。
3. `fixtures/embedding-quality/source/source-manifest.json` に入力一覧を出力。

### Step 2: 固定Python環境と参照モデルの配備 (`scripts/quality/g03-prepare.ts`)
1. **Python固定ランタイムの構築**:
   - ホスト環境の差異を排除するため、固定された wheel パッケージ群（`requirements.lock` に全 wheel の SHA-256 を固定）から専用の仮想環境（venv）を構築する。
   - 使用パッケージ:
     - `torch`, `torchvision`
     - `transformers`, `sentence-transformers`
     - `onnxruntime`
     - `safetensors`, `Pillow`
2. **モデル資材の搬入**:
   - 元モデル（約 1.52 GB、PyTorch safetensors 等の必須6ファイル）を配置。
   - ONNX FP32 モデル（約 1.76 GB、ONNX グラフおよび外部データファイル）を配置。
   - 各ファイルの SHA-256 ダイジェストとファイルサイズが固定仕様に一致するか検証。

### Step 3: 各モデルによるベクトル推論とバイナリ出力
推論ドライバー（`g03-reference-generation.ts` / Python 推論スクリプト）を用いて、同一の入力セットに対し推論を実行する。

1. **元モデル (`modelReferenceVector`)**:
   - PyTorch + Transformers でモデルをロード。
   - 各テキスト・画像を推論し、768次元埋め込みを取得。
   - IEEE 754 リトルエンディアンの Float32Array（3,072 bytes）として `vectors/model/{id}.bin` に保存。
2. **ONNX FP32 変換モデル (`conversionVector`)**:
   - ONNX Runtime（CPU EP）で ONNX FP32 グラフを実行。
   - 各入力を推論し、同様に 3,072 bytes のバイナリとして `vectors/conversion/{id}.bin` に保存。
3. **Q4 量子化モデル (`q4Vector`)**:
   - 本プロジェクトの Q4 モデル（ONNX INT4）を ONNX Runtime または本製品の推論エンジン（Wasm / DirectML）で実行。
   - 出力ベクトルを `vectors/q4/{id}.bin` に保存。

### Step 4: `manifest.json` の作成とロック
全出力ベクトルの相対パス、使用したモデルリビジョン、ツールのバージョン番号をまとめ、`fixtures/embedding-quality/manifest.json` を生成する。

---

## 4. G03 品質ゲートの検証実行

### 4.1 独立品質ゲート試験 (`test-embedding-quality.ts`)
固定マニフェストと全バイナリベクトルを直接読み込み、コサイン類似度の集計・判定を行う。

```shell
npm run test:embedding-quality
# または
node scripts/run.ts test-embedding-quality
```

#### 実行結果
- **合格時**:
  - `artifacts/release-gates/embedding-quality.json` に判定レポート（各モダリティの件数、平均、最小値、合否）が出力され、戻り値 0 で終了する。
  - 既存の blocker ファイル（`artifacts/release-gates/embedding-quality-blocker.json`）は自動削除される。
- **資材未配置・不備時 (安全なブロック)**:
  - 偽造やモックによる通過を防ぐため、`fixtures/embedding-quality/` の資材が不足している場合は `artifacts/release-gates/embedding-quality-blocker.json` に以下を記録して exit code 1 で停止する：
    ```json
    {
      "stage": "embedding-quality",
      "status": "blocked",
      "reason": "REFERENCE_FIXTURES_UNAVAILABLE"
    }
    ```

### 4.2 実配布 SQLite 統合推論品質試験 (`test-official-quality.ts`)
製品ビルド済みの SQLite Wasm 配布バイナリをロードし、SQL 関数 `SELECT embedding_query(?)` を実際に呼び出して全入力を推論し、`conversionVector` と比較する。

```shell
# Wasm バックエンドでの検証
node scripts/run.ts test-official-quality wasm

# DirectML バックエンドでの検証
node scripts/run.ts test-official-quality directml
```

- レポート出力先:
  - `artifacts/release-gates/official-quality-wasm.json`
  - `artifacts/release-gates/official-quality-directml.json`

---

## 5. 単体テストにおける品質ロジックの保証

実資材がない CI / 開発環境でも、品質評価ロジック自体が退行しないよう `test/unit/embedding-quality.test.ts` が用意されている。
- コサイン類似度 1.0 および 0.0 の決定論的単位ベクトルによる合格・不合格の集計検証。
- 単一要素の劣化が全体判定を正しく失敗させることの確認。
- 異常入力（欠損モダリティ、重複 ID、768 次元以外、NaN、Inf、全ゼロベクトル）の拒否（`E_INPUT`, `E_EMBEDDING_VALUE`）検証。
