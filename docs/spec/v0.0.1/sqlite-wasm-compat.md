# v0.0.1 公式 9 デモ互換検証手順（SQLite WASM / Parcel 対応）

## 1. 概要

本手順書は、上流 `@sqlite.org/sqlite-wasm`（固定コミット `ccbb81134a3b5a824f8a3cc3c5d8edd6e799ab5a`）に含まれる公式 9 デモとの完全互換性を検証するための実施手順、および各種バンドラー（特に **Parcel**）における配慮事項・前提条件をまとめたものである。

製品受入基準（[acceptance.md](acceptance.md) 第 4 項）に従い、**デモ側のソースコードや設定を一切改変することなく、パッケージの差し替えのみでブラウザ上の出力行が完全一致すること** を受入条件とする。

---

## 2. 公式 9 デモ一覧と期待値

| デモ名 | バンドラー | VFS / 動作形態 | 期待される表示行 (`#app li`) |
| :--- | :---: | :--- | :--- |
| `main-thread-demo` | Vite | メインスレッド基本実行 | `1: Alice`、`2: Bob` |
| `in-worker-demo` | Vite | Web Worker 実行 | `1: InWorker 1`、`2: InWorker 2` |
| `opfs-demo` | Vite | OPFS 基本 VFS | `1: OPFS 1`、`2: OPFS 2` |
| `opfs-wl-demo` | Vite | OPFS Web Lock VFS | `1: OPFS-WL 1`、`2: OPFS-WL 2` |
| `kvvfs-demo` | Vite | Key-Value VFS | `1: kvvfs 1`、`2: kvvfs 2` |
| `sahpool-demo` | Vite | OPFS SAHPool VFS | `1: Alice`、`2: Bob` |
| `sahpool-webpack-demo` | Webpack | OPFS SAHPool VFS + Webpack | `1: Alice`、`2: Bob` |
| `sahpool-parcel-demo` | Parcel | OPFS SAHPool VFS + Parcel | `1: Alice`、`2: Bob` |
| `sahpool-rsbuild-demo` | Rsbuild | OPFS SAHPool VFS + Rsbuild | `1: Alice`、`2: Bob` |

---

## 3. Parcel 検証における注意点と設計上の配慮

`sahpool-parcel-demo` は、Web Worker 内で OPFS SAHPool VFS（SyncAccessHandle Pool）を起動し、Parcel 2 でバンドルする構成をとっている。本プロジェクトでは以下の点に配慮している。

### 3.1 パッケージエクスポートとゼロ設定解決 (`exports` 整合性)
- **課題**: Parcel は設定不要（zero-config）を基本とし、`package.json` の `exports` フィールドを厳格に解釈する。
- **配慮点**:
  - [product.md](product.md) に定義されたエクスポート構造に基づき、ブラウザ環境では `dist/index-browser.mjs` を、WASM バイナリは `./sqlite3.wasm`（`dist/sqlite3.wasm`）として直接公開している。
  - バンドラー向けエントリポイント（`sqlite3-bundler-friendly.mjs`）内部の `new URL('sqlite3.wasm', import.meta.url)` 相対 URL 参照を Parcel が静的アセットとして正しく認識し、dist 出力先へハッシュ付きまたは同一名でコピー・リンク可能としている。

### 3.2 Web Worker と ESM ターゲット (`outputFormat: "esmodule"`)
- **Worker 構文**: デモ側の `main.js` では標準の Web Worker 構文が使用されている。
  ```javascript
  const worker = new Worker(new URL('./workers/worker.ts', import.meta.url), {
    type: 'module',
  });
  ```
- **Parcel ターゲット設定**: デモ側の `package.json` で以下のターゲットが指定されている。
  ```json
  "targets": {
    "default": {
      "outputFormat": "esmodule",
      "optimize": false
    }
  }
  ```
  Parcel はこの設定に基づき、TypeScript で記述された Worker スクリプトを個別の ESM チャンクとしてバンドルする。当パッケージ側も ESM（`dist/index-browser.mjs`）として提供することで、Worker 内でのモジュール解決や Top-Level Await が破綻なく動作する。

### 3.3 OPFS SAHPool / SharedArrayBuffer に必須の Cross-Origin Isolation (COOP / COEP)
- **要件**: OPFS SAHPool VFS（`installOpfsSAHPoolVfs`）はブラウザの `FileSystemSyncAccessHandle` および `SharedArrayBuffer` に依存する。これらを有効化するには、配信サーバー側で以下の HTTP レスポンスヘッダーが必須となる。
  - `Cross-Origin-Opener-Policy: same-origin`
  - `Cross-Origin-Embedder-Policy: require-corp`
- **配慮点**: 検証ハーネス（`test/integration/test-sqlite-wasm-compat.ts` / `serveSqliteDemo`）において、Parcel のビルド成果物を配信するローカルサーバーにこれらのヘッダーを付与し、ブラウザのセキュリティ制限による VFS 初期化失敗を防止している。

### 3.4 ネイティブスクリプト実行制限 (`allowScripts`)
- **要件**: Parcel はファイル監視用にネイティブモジュール `@parcel/watcher` を利用するが、環境差異による node-gyp ビルドの失敗や、依存関係起因の任意コード実行を防止する必要がある。
- **配慮点**: ルートの `package.json` において、`allowScripts` に `"@parcel/watcher@2.6.0": false` を設定し、ビルド・インストール時の決定論的かつ安全な動作を保証している。

### 3.5 キャッシュ管理 (`.parcel-cache`)
- **配慮点**: Parcel が生成する中間キャッシュディレクトリ `.parcel-cache` および `.cache` を `.gitignore` に明記し、Git 差分やテスト環境の一時領域汚染を防止している。

---

## 4. 事前準備と前提条件

互換性検証を実行する前に、以下の準備が完了していることを確認する。

1. **上流固定アーカイブの配置**:
   - `downloads/sqlite-wasm-ccbb81134a3b5a824f8a3cc3c5d8edd6e799ab5a.tar.gz`
   - 不在の場合は `node scripts/download-assets.mjs` を実行して資材を取得・検証する。
2. **製品ビルドの完了**:
   ```bash
   npm run build
   ```
   - `dist/index-browser.mjs`、`dist/sqlite3.wasm` 等のブラウザ配布資材が生成されていること。
3. **ブラウザ検証環境**:
   - Playwright による実ブラウザテストのため、Microsoft Edge または Chromium が利用可能であること。

---

## 5. 検証実施手順

### 5.1 全 9 デモの一括検証
全 9 デモを一括実行し、全件 PASS および上流 smoke テストの合格を確認する。

```bash
npm run test:sqlite-wasm-compat
```
または
```bash
node scripts/run.ts test-sqlite-wasm-compat
```

### 5.2 Parcel デモ単体の個別検証
Parcel デモのみを対象としてデバッグ・検証を行う場合、第 2 引数にデモ名を指定する。

```bash
node scripts/run.ts test-sqlite-wasm-compat sahpool-parcel-demo
```

### 5.3 内部実行フロー
`test/integration/test-sqlite-wasm-compat.ts` が起動されると、以下の順序で処理が進行する：

1. **デモ展開**:
   - `.build/sqlite-wasm-compat-XXXXXX` の一時ディレクトリを作成。
   - `tar -xf downloads/sqlite-wasm-ccbb81134a3b5a824f8a3cc3c5d8edd6e799ab5a.tar.gz` により、未変更のデモディレクトリ（`demos/`）を展開。
2. **バンドル生成**:
   - `sahpool-parcel-demo` の場合、Parcel を起動して `index.html` を起点に `dist` ディレクトリへバンドル出力。
   - 依存先 `@sqlite.org/sqlite-wasm` を当プロジェクトの `dist/index-browser.mjs` へ紐付ける。
3. **ローカル配信**:
   - COOP / COEP ヘッダーを付加した HTTP サーバーを起動（`127.0.0.1:<port>`）。
4. **ブラウザ自動検証 (Playwright)**:
   - ヘッドレス Edge/Chromium を起動し、デモページにアクセス。
   - 外部ネットワークへの不要なリクエストが発生していないか監視（`externalRequests === 0`）。
   - `#app li` 要素がレンダリングされるまで待機（最大 30 秒）。
   - 取得されたテキスト行が期待値（`1: Alice`, `2: Bob`）と完全一致するか検証。
5. **レポート出力**:
   - 検証結果レポートが `artifacts/release-gates/sqlite-wasm-compat.json` に出力される。
6. **一時領域クリーンアップ**:
   - 検証完了後、ブラウザを終了し、`.build/sqlite-wasm-compat-XXXXXX` を自動削除。
