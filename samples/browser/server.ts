import { createServer, type ServerResponse } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, resolve, join } from "node:path";

const rootDir = process.cwd();
const port = parseInt(process.env.PORT ?? "8080", 10);

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

function setHeaders(res: ServerResponse, mime: string) {
  res.setHeader("Content-Type", mime);
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

export function startSampleServer(listenPort: number = port) {
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
