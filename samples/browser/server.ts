/**
 * 処理名: ブラウザサンプル用ローカル配信サーバ
 * 処理概要: COOP/COEP ヘッダーを付与して静的ファイルを配信する Node.js HTTP サーバ。
 * 実装理由: SharedArrayBuffer および OPFS SAHPool をブラウザで安全に動作させるため。
 */
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";

const PORT = 8080;
const rootDir = process.cwd();

const MIME_MAP: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".wasm": "application/wasm",
  ".json": "application/json"
};

/**
 * 処理名: HTTP リクエストハンドラ
 * 処理概要: クロスオリジン分離ヘッダーを付与して要求されたファイルを読み出し応答する。
 */
const server = http.createServer((req, res) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");

  const urlPath = req.url === "/" ? "/index.html" : (req.url ?? "/index.html");
  const cleanPath = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(rootDir, "dist", cleanPath);

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath);
    res.setHeader("Content-Type", MIME_MAP[ext] || "application/octet-stream");
    res.writeHead(200);
    fs.createReadStream(filePath).pipe(res);
  } else {
    res.writeHead(404);
    res.end("Not Found");
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}/`);
  });
}

export default server;
