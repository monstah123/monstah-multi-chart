// ────────────────────────────────────────────────────────────────────
// serve.js — zero-dependency static file server with one proxy route.
//
//   /api/yahoo-history?symbol=AAPL&interval=1d&range=2y
//       ↓ server-side fetch to Yahoo Finance v8, returned as CORS-able JSON
//
// Why a proxy: Yahoo Finance's public chart endpoint doesn't send
// Access-Control-Allow-Origin for arbitrary origins, and the whole
// point is keeping this local — no third-party relay, no data leaving
// the machine except direct outgoing HTTPS to the data source.
//
// Everything else is served from this directory:
//   /              → index.html
//   /styles.css    → styles.css
//   /dist/main.js  → dist/main.js
// SECURITY: never log query strings (symbols are fine; tokens are not
// ever accepted), don't follow symlinks, don't accept path traversal.
// ────────────────────────────────────────────────────────────────────

import http from "node:http";
import { createReadStream, statSync } from "node:fs";
import { extname, join, resolve, relative, dirname } from "node:path";
import { URL } from "node:url";
import { fileURLToPath } from "node:url";

const BIN_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(BIN_DIR, "..");
const PORT = Number(process.env.PORT || 8080);
const IB_BRIDGE = `http://127.0.0.1:${Number(process.env.IB_BRIDGE_PORT || 8099)}`;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".map":  "application/json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".ico":  "image/x-icon",
};

function safeJoin(root, rel) {
  const joined = resolve(join(root, rel));
  const re = relative(root, joined);
  if (re.startsWith("..") || re.includes("\0")) return null; // escaped root
  return joined;
}

async function handleYahoo(url, res) {
  const symbol = (url.searchParams.get("symbol") || "").trim();
  const interval = (url.searchParams.get("interval") || "1d").trim();
  const range = (url.searchParams.get("range") || "6mo").trim();
  if (!/^[A-Za-z0-9.^=_-]{1,32}$/.test(symbol)) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "invalid symbol" }));
    return;
  }
  const allowedIntervals = new Set(["1m","5m","15m","30m","60m","90m","1h","4h","1d","1wk","1mo"]);
  const allowedRanges = new Set(["1d","5d","1mo","3mo","6mo","1y","2y","5y","10y","ytd","max"]);
  if (!allowedIntervals.has(interval) || !allowedRanges.has(range)) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unsupported interval or range" }));
    return;
  }
  const upstream = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}&includePrePost=false`;
  try {
    const r = await fetch(upstream, {
      headers: { "user-agent": "Mozilla/5.0 (compatible; multi-chart/1.0)" },
      redirect: "follow",
    });
    const body = await r.text();
    res.writeHead(r.ok ? 200 : r.status, {
      "content-type": r.ok ? "application/json" : "text/plain; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(body);
  } catch (err) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "yahoo fetch failed", detail: String(err).slice(0, 200) }));
  }
}

async function handleQuotes(url, res) {
  const ua = { "user-agent": "Mozilla/5.0 (compatible; multi-chart/1.0)" };
  const split = (raw) =>
    (raw || "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => /^[A-Za-z0-9.^=_-]{1,32}$/.test(s))
      .slice(0, 60);
  const binance = split(url.searchParams.get("binance"));
  const yahoo = split(url.searchParams.get("yahoo"));
  const ib = split(url.searchParams.get("ib"));
  const quotes = {};

  if (binance.length) {
    const take = (rows) => {
      for (const t of rows) {
        const price = Number(t.lastPrice);
        const pct = Number(t.priceChangePercent);
        if (Number.isFinite(price)) quotes[t.symbol] = { price, changePct: Number.isFinite(pct) ? pct : undefined };
      }
    };
    try {
      const q = encodeURIComponent(JSON.stringify(binance));
      const r = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbols=${q}`, { headers: ua });
      if (r.ok) take(await r.json());
      else {
        // one bad symbol rejects the whole batch — retry individually
        const settled = await Promise.allSettled(
          binance.map(async (sym) => {
            const rr = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${sym}`, { headers: ua });
            return rr.ok ? [await rr.json()] : [];
          }),
        );
        for (const s of settled) if (s.status === "fulfilled") take(s.value);
      }
    } catch { /* network hiccup — next poll retries */ }
  }

  // Yahoo Finance batch "spark" endpoint — the v7/quote endpoint now requires
  // auth (401), spark does not. Yahoo stores US class shares with a dash
  // (BRK.B → BRK-B), so a dotted symbol is retried with dashes and the result is
  // keyed back onto the requested ticker. Returns a Map of requested → {price, pct}.
  // Yahoo intermittently drops/429s a batch with no explanation, so retry once
  // after a short delay and keep batches small rather than failing wholesale.
  const fetchSparkMap = async (symbols, attempt = 1) => {
    const out = new Map();
    if (!symbols.length) return out;
    const doFetch = async (list) => {
      try {
        const syms = encodeURIComponent(list.join(","));
        const r = await fetch(`https://query1.finance.yahoo.com/v7/finance/spark?symbols=${syms}`, { headers: ua });
        if (!r.ok) return null;
        const j = await r.json();
        const m = new Map();
        for (const row of j?.spark?.result ?? []) {
          const meta = row?.response?.[0]?.meta;
          const price = typeof meta?.regularMarketPrice === "number" ? meta.regularMarketPrice : undefined;
          const pct = typeof meta?.regularMarketChangePercent === "number" ? meta.regularMarketChangePercent : undefined;
          if (row?.symbol && (Number.isFinite(price) || Number.isFinite(pct))) m.set(row.symbol, { price, pct });
        }
        return m;
      } catch (err) { return null; }
    };
    let m = await doFetch(symbols);
    if (!m && attempt < 2) { await new Promise((res) => setTimeout(res, 400)); m = await doFetch(symbols); }
    if (m) for (const [sym, q] of m) out.set(sym, q);
    // dotted symbols with no direct hit — retry as dashes
    const missing = symbols.filter((s) => !out.has(s) && s.includes("."));
    if (missing.length) {
      const alts = missing.map((s) => s.replace(/\./g, "-"));
      const m2 = await doFetch(alts);
      if (m2) for (let i = 0; i < missing.length; i++) {
        const hit = m2.get(alts[i]);
        if (hit) out.set(missing[i], hit);
      }
    }
    return out;
  };
  const fetchSpark = async (symbols) => {
    if (!symbols.length) return;
    const m = await fetchSparkMap(symbols);
    for (const [sym, q] of m) if (Number.isFinite(q.price)) quotes[sym] = { price: q.price, changePct: q.pct };
  };

  await fetchSpark(yahoo);

  // IB bridge quotes (live FX via IBKR Pro). The bridge supplies the price but
  // NO change%, and in this account its FX quotes are simply a subscribe-time
  // snapshot that never refreshes — so use them only when fresh (≤3 min) and
  // let Yahoo spark provide change% on top (price stays the IB live mid).
  // Stale/missing symbols fall back to full spark (price + %).
  const STALE_MS = 3 * 60_000;
  const needYahooFallback = [];
  const freshBridge = [];
  if (ib.length) {
    try {
      const syms = encodeURIComponent(ib.join(","));
      const r = await fetch(`${IB_BRIDGE}/quotes?symbols=${syms}`, { headers: ua });
      if (r.ok) {
        const j = await r.json();
        const now = Date.now();
        for (const [sym, q] of Object.entries(j?.quotes ?? {})) {
          const price = typeof q?.price === "number" ? q.price : undefined;
          const t = typeof q?.t === "number" ? q.t : 0;
          if (price === undefined || now - t > STALE_MS) continue; // stale → spark below
          quotes[sym] = { price, changePct: undefined };
          freshBridge.push(sym);
        }
      }
    } catch { /* bridge unreachable */ }
    // Merge Yahoo's change% onto fresh bridge rows (IB has none). Price stays IB.
    if (freshBridge.length) {
      const m = await fetchSparkMap(freshBridge);
      for (const [sym, q] of m) if (quotes[sym] && typeof q.pct === "number") quotes[sym].changePct = q.pct;
    }
    for (const sym of ib) if (!quotes[sym]) needYahooFallback.push(sym);
  }
  // Small batches (≤9) with a pause between them — Yahoo is likelier to honor
  // them, and one dropped batch blanks only its chunk instead of all stocks.
  const SPARK_CHUNK = 9;
  for (let i = 0; i < needYahooFallback.length; i += SPARK_CHUNK) {
    await fetchSpark(needYahooFallback.slice(i, i + SPARK_CHUNK));
    if (i + SPARK_CHUNK < needYahooFallback.length) await new Promise((res) => setTimeout(res, 250));
  }

  res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify({ quotes }));
}

async function handleIb(url, res) {
  const upstream = IB_BRIDGE + url.pathname.replace(/^\/api\/ib/, "") + (url.search || "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const r = await fetch(upstream, { signal: controller.signal });
    const body = await r.text();
    res.writeHead(r.status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(body);
  } catch {
    res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ connected: false, error: "IB bridge not running — start it with: npm run ib" }));
  } finally {
    clearTimeout(timer);
  }
}

const server = http.createServer((req, res) => {
  void (async () => {
    try {
      const url = new URL(req.url || "/", "http://localhost");
      if (url.pathname === "/api/yahoo-history" && req.method === "GET") {
        await handleYahoo(url, res);
        return;
      }
      if (url.pathname === "/api/quotes" && req.method === "GET") {
        await handleQuotes(url, res);
        return;
      }
      if (url.pathname.startsWith("/api/ib/") && req.method === "GET") {
        await handleIb(url, res);
        return;
      }
      if (url.pathname === "/favicon.ico") {
        res.writeHead(204).end();
        return;
      }
      const rel = url.pathname === "/" ? "/index.html" : url.pathname;
      const fp = safeJoin(ROOT, decodeURIComponent(rel));
      if (!fp) { res.writeHead(404).end("not found"); return; }
      let st;
      try { st = statSync(fp); } catch { res.writeHead(404).end("not found"); return; }
      if (!st.isFile()) { res.writeHead(404).end("not found"); return; }
      const ct = MIME[extname(fp).toLowerCase()] || "application/octet-stream";
      res.writeHead(200, { "content-type": ct, "content-length": st.size, "cache-control": "no-store" });
      createReadStream(fp).pipe(res);
    } catch (err) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("server error: " + String(err).slice(0, 200));
    }
  })();
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Multi-Chart local: http://localhost:${PORT}`);
  console.log(`Data: Binance REST/WS (realtime crypto) · IBKR Pro via bridge for stocks/FX (Yahoo spark fallback) · Yahoo spark for indices/commodities`);
});
