#!/usr/bin/env node
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const PORT = 3737;
const HTML_FILE = path.resolve(__dirname, "listings.html");

let scraping = false;
let lastLog = [];

const server = http.createServer((req, res) => {
  // CORS for fetch from same origin
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.method === "GET" && req.url === "/") {
    try {
      const html = fs.readFileSync(HTML_FILE, "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch {
      res.writeHead(404);
      res.end("listings.html not found — run node run.js first");
    }
    return;
  }

  if (req.method === "POST" && req.url === "/refresh") {
    if (scraping) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "already running" }));
      return;
    }
    scraping = true;
    lastLog = [];
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));

    const child = spawn("node", ["run.js"], { cwd: __dirname });
    child.stdout.on("data", (d) => {
      const line = d.toString().trim();
      lastLog.push(line);
      process.stdout.write(d);
    });
    child.stderr.on("data", (d) => process.stderr.write(d));
    child.on("close", () => { scraping = false; });
    return;
  }

  if (req.method === "GET" && req.url === "/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ scraping, lastLog: lastLog.slice(-5) }));
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => {
  console.log(`[server] http://localhost:${PORT}`);
  const { exec } = require("child_process");
  exec(`xdg-open http://localhost:${PORT}`);
});
