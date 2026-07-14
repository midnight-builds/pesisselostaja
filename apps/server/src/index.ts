// Minimal static host for the built web app (apps/web/dist) on :3000.
// No watcher, no API endpoints — the browser app talks to pesistulokset
// directly. Replaces v1's server as the pesisselostaja.service exec target.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const WEB_DIST = fileURLToPath(new URL("../../web/dist", import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".onnx": "application/octet-stream",
  ".map": "application/json",
  ".webmanifest": "application/manifest+json",
};

const server = createServer(async (req, res) => {
  const method = req.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") {
    res.writeHead(405, { "Content-Type": "text/plain", Allow: "GET, HEAD" });
    res.end("Method Not Allowed");
    return;
  }

  const path = (req.url ?? "/").replace(/[?#].*$/, "");

  // Old bookmarks: the v1 server hosted the app under /v2/.
  if (path === "/v2" || path.startsWith("/v2/")) {
    const rest = path.replace(/^\/v2\/?/, "");
    res.writeHead(301, { Location: "/" + rest });
    res.end();
    return;
  }

  const rel = path.replace(/^\/+/, "") || "index.html";
  const filePath = normalize(join(WEB_DIST, rel));
  if (filePath !== WEB_DIST && !filePath.startsWith(WEB_DIST + "/")) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Forbidden");
    return;
  }

  let file = filePath;
  let buf: Buffer;
  try {
    buf = await readFile(file);
  } catch {
    // SPA fallback: unknown paths render the app shell.
    file = join(WEB_DIST, "index.html");
    try {
      buf = await readFile(file);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("web build not found — run `npm run build -w @pesisselostaja/web`");
      return;
    }
  }

  res.writeHead(200, {
    "Content-Type": MIME[extname(file)] ?? "application/octet-stream",
    "Content-Length": buf.length,
  });
  res.end(method === "HEAD" ? undefined : buf);
});

server.listen(PORT, () => {
  console.log(`pesisselostaja web app on http://0.0.0.0:${PORT}/ (serving ${WEB_DIST})`);
});
