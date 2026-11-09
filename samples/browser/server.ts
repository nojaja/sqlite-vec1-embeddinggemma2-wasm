import { createServer, type Server, type ServerResponse } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, resolve, join } from "node:path";

const rootDir = process.cwd();
const port = parseInt(process.env.PORT ?? "8080", 10);

/**
 * 処理名: MIMEタイプ判定
 * 処理概要: ファイル拡張子に対応するMIMEタイプ文字列を返す。
 * 実装理由: 静的ファイルを適切なContent-Typeでブラウザへ配信するため。
 * @param filename - 判定対象のファイル名またはパス。
 * @returns MIMEタイプ文字列。
 */
function getMime(filename: string): string {
  const ext = extname(filename);
  switch (ext) {
    case ".html": return "text/html; charset=utf-8";
    case ".js":
    case ".mjs": return "text/javascript; charset=utf-8";
    case ".wasm": return "application/wasm";
    case ".json": return "application/json; charset=utf-8";
    case ".png": return "image/png";
    default: return "application/octet-stream";
  }
}

/**
 * 処理名: セキュリティヘッダー設定
 * 処理概要: COOP/COEPなどの必須HTTPヘッダーをレスポンスに設定する。
 * 実装理由: SharedArrayBufferを有効化してWasmマルチスレッド動作を可能にするため。
 * @param res - HTTPレスポンスオブジェクト。
 * @param mime - Content-Typeに設定するMIMEタイプ文字列。
 */
function setHeaders(res: ServerResponse, mime: string): void {
  res.setHeader("Content-Type", mime);
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

/**
 * 処理名: サンプルサーバー起動
 * 処理概要: ローカル配信用のHTTPサーバーを初期化してポートで待受開始する。
 * 実装理由: サンプルページおよびアセットをブラウザで検証可能にするため。
 * @param listenPort - 待受ポート番号。
 * @returns 起動したHTTPサーバーインスタンス。
 */
export function startSampleServer(listenPort: number = port): Server {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === "/") pathname = "/samples/browser/index.html";

    const filePath = resolve(join(rootDir, pathname));
    if (!filePath.startsWith(rootDir) || !existsSync(filePath) || !statSync(filePath).isFile()) {
      res.writeHead(404).end();
      return;
    }

    setHeaders(res, getMime(filePath));
    createReadStream(filePath).pipe(res);
  });

  server.listen(listenPort, "127.0.0.1", () => {
    console.log(`Sample server running at http://127.0.0.1:${listenPort}/`);
  });

  return server;
}

if (require.main === module) {
  startSampleServer();
}
