# v0.0.1 製品設計

SQLite公式API、vec1とEmbeddingGemma 2を統合するpackageの設計です。以下の文書を合わせて実装してください。

実施順序、失敗時の戻り先、moduleの責務分担は[開発ガイド](../../development.md)を参照してください。本表の製品契約が正本であり、手順書によって必須機能や合格条件を省略しません。

| 文書 | 内容 |
| --- | --- |
| [product.md](product.md) | 公開API、SQL関数、期限、LRU、エラー |
| [inference.md](inference.md) | 固定モデル、画像処理、DirectML/WebGPU、取得とcache、Worker protocol |
| [storage.md](storage.md) | metadata、Node file VFS、SAH pool、復旧 |
| [build.md](build.md) | SQLite再生成、推論ビルド、製品パッケージバンドル、配布 |
| [internal-api.md](internal-api.md) | モジュール構成、export型、外部I/O境界、テスト用interface |
| [acceptance.md](acceptance.md) | 単体・integration・E2Eの合格条件 |
| [assets.md](assets.md) | 外部資材の入手URLと保存先 |
| [linux-toolchain.md](linux-toolchain.md) | Linux再生成環境の準備（Emscripten/ホストdeb依存） |

公開package名は `@nojaja/sqlite-vec1-embeddinggemma2-wasm`、versionは `0.0.1` です。`@sqlite.org/sqlite-wasm` の完全なドロップイン互換（drop-in replacement）として設計され、利用者が `package.json` の依存先を切り替えるだけで、通常SQL・vec1仮想テーブルに加えてベクトル埋め込みカスタム関数群が即座に利用可能となります。npm公開設定（`publishConfig.access: "public"`）、パッケージ内相対パス解決、メインスレッド制約の緩和、ブラウザ推論正式接続、および公式TypeScript型定義との完全互換を提供します。TypeScript/CommonJSを用い、browserにはESMを生成します。SQLite/vec1はC静的組み込み再生成Wasm、推論backendはWasm既定で明示選択（DirectML、WebGPU）し、自動fallbackは行いません。

取得資材はdownloads、モデルはmodelへ保存します。製品source、build、sampleを実装し、同梱テストの期待値を維持して実環境で動作を確認してください。生成reportの存在だけを合格にせず、各試験を実行します。
