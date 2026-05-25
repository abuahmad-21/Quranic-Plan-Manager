const path = require("path");
const fs = require("fs");
const http = require("http");
const PUBLIC = path.join(__dirname, "..", "quran-coach", "public");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2"
};
const origCreate = http.createServer.bind(http);
let apiHandler;
function getApiHandler() {
  if (apiHandler) return apiHandler;
  http.createServer = fn => {
    apiHandler = fn;
    return { listen: () => {}, on: () => ({ listen: () => {} }), close: () => {} };
  };
  const prev = process.cwd();
  process.chdir(path.join(__dirname, "..", "quran-coach"));
  require("../quran-coach/server.js");
  process.chdir(prev);
  http.createServer = origCreate;
  return apiHandler;
}
module.exports = (req, res) => {
  const urlPath = req.url.split("?")[0];
  const ext = path.extname(urlPath);
  if (urlPath.startsWith("/api") || urlPath.startsWith("/ws")) {
    const fn = getApiHandler();
    return fn ? fn(req, res) : (res.statusCode = 500, res.end("error"));
  }
  const fp = path.join(PUBLIC, urlPath === "/" ? "index.html" : urlPath);
  try {
    const data = fs.readFileSync(fp);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    return res.end(data);
  } catch (_) {
    try {
      const html = fs.readFileSync(path.join(PUBLIC, "index.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(html);
    } catch (_2) {
      res.writeHead(404);
      res.end("Not found");
    }
  }
};
