import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const port = Number(process.env.GMVMAX_DASHBOARD_PORT || 8787);
const host = process.env.GMVMAX_DASHBOARD_HOST || "127.0.0.1";

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".csv", "text/csv; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".png", "image/png"]
]);

function safePath(urlPath) {
  const pathname = decodeURIComponent(urlPath === "/" ? "/dashboard.html" : urlPath);
  const resolved = path.resolve(rootDir, `.${pathname}`);
  if (!resolved.startsWith(rootDir)) return null;
  return resolved;
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host}`);
    const filePath = safePath(url.pathname);
    if (!filePath) {
      response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      response.end("Forbidden");
      return;
    }

    const body = await fs.readFile(filePath);
    const type = contentTypes.get(path.extname(filePath).toLowerCase()) || "application/octet-stream";
    response.writeHead(200, {
      "content-type": type,
      "cache-control": "no-store"
    });
    response.end(body);
  } catch (error) {
    const status = error.code === "ENOENT" ? 404 : 500;
    response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
    response.end(status === 404 ? "Not found" : error.message);
  }
});

server.listen(port, host, () => {
  console.log(`GMV Max dashboard server running at http://${host}:${port}/dashboard.html`);
});
