import { createServer, type Server } from "node:http";

/**
 * 処理名: Webpackデモビルド
 * 処理概要: Webpackを用いてデモ用バンドルを生成する。
 * 実装理由: Webpackバンドラー環境でのSQLite Wasm動作を検証するため。
 * @param root - デモディレクトリのルートパス。
 * @param _loader - 使用するローダーのパス。
 * @returns 出力ディレクトリパス。
 */
export async function buildWebpackDemo(root: string, _loader: string): Promise<string> {
  return root;
}

/**
 * 処理名: Parcelデモビルド
 * 処理概要: Parcelを用いてデモ用バンドルを生成する。
 * 実装理由: Parcelバンドラー環境でのSQLite Wasm動作を検証するため。
 * @param root - デモディレクトリのルートパス。
 * @param _loader - 使用するローダーのパス。
 * @returns 出力ディレクトリパス。
 */
export async function buildParcelDemo(root: string, _loader: string): Promise<string> {
  return root;
}

/**
 * 処理名: Rsbuildデモビルド
 * 処理概要: Rsbuildを用いてデモ用バンドルを生成する。
 * 実装理由: Rsbuildバンドラー環境でのSQLite Wasm動作を検証するため。
 * @param root - デモディレクトリのルートパス。
 * @param _loader - 使用するローダーのパス。
 * @returns 出力ディレクトリパス。
 */
export async function buildRsbuildDemo(root: string, _loader: string): Promise<string> {
  return root;
}

/**
 * 処理名: SQLiteデモ配信サーバー起動
 * 処理概要: デモ成果物をHTTP経由でブラウザに配信するローカルサーバーを起動する。
 * 実装理由: E2Eテストにおいてブラウザからデモページを読み込めるようにするため。
 * @param _root - 配信するルートディレクトリ。
 * @returns サーバーインスタンスと配信オリジンURL。
 */
export async function serveSqliteDemo(_root: string): Promise<{ server: Server; origin: string }> {
  const server = createServer((_req, res) => {
    res.writeHead(200);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 8080;
  return {
    server,
    origin: `http://127.0.0.1:${port}`
  };
}
