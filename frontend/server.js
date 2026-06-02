const http = require("http");
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const root = __dirname;
const port = Number(process.env.PORT || 5173);
const host = "127.0.0.1";
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png"
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);

  if (url.pathname === "/api/logs") {
    proxyLogs(url, res);
    return;
  }

  const safePath = path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(root, safePath === "/" ? "index.html" : safePath);

  if (!filePath.startsWith(root)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    res.writeHead(200, {
      "Content-Type": types[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store, max-age=0",
    });
    res.end(data);
  });
});

function getExplorerApiUrl(chainId) {
  if (chainId === 56)  return "https://api.bscscan.com/api";
  if (chainId === 97)  return "https://api-testnet.bscscan.com/api";
  // Etherscan V2 multi-chain endpoint for Ethereum networks
  return "https://api.etherscan.io/v2/api";
}

function proxyLogs(url, res) {
  const chainId = Number(url.searchParams.get("chainid") || "97");
  const apiKey = process.env.BSCSCAN_API_KEY || process.env.ETHERSCAN_API_KEY || "";
  const apiUrl = getExplorerApiUrl(chainId);

  const params = new URLSearchParams({
    module: "logs",
    action: "getLogs",
    fromBlock: String(url.searchParams.get("fromBlock") || "0"),
    toBlock: String(url.searchParams.get("toBlock") || "latest"),
    address: String(url.searchParams.get("address") || ""),
    apikey: apiKey,
  });

  // Etherscan V2 multi-chain needs chainid param; BscScan does not
  if (chainId !== 56 && chainId !== 97) {
    params.set("chainid", String(chainId));
  }

  for (const key of ["topic0", "topic1", "topic2", "topic3"]) {
    const value = url.searchParams.get(key);
    if (value) params.set(key, value);
  }

  fetch(`${apiUrl}?${params.toString()}`)
    .then((response) => response.text())
    .then((body) => {
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store, max-age=0",
      });
      res.end(body);
    })
    .catch((error) => {
      res.writeHead(502, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store, max-age=0",
      });
      res.end(JSON.stringify({ status: "0", message: "Proxy error", result: error.message }));
    });
}

server.listen(port, host, () => {
  console.log(`Arvo frontend: http://${host}:${port}`);
});
