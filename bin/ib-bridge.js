// ────────────────────────────────────────────────────────────────────
// ib-bridge.js — local HTTP bridge between this chart app and
// Interactive Brokers (TWS or IB Gateway) via the @stoqey/ib client.
//
//   Start:   npm run ib
//   Env:     IB_HOST=127.0.0.1          (gateway host)
//            IB_PORT=<port>             (optional: force a port,
//                                        else auto-detects 4001/4002/7496/7497)
//            IB_CLIENT_ID=32
//            IB_DATA_TYPE=1             (1 live · 2 frozen · 3 delayed · 4 delayed-frozen)
//            IB_BRIDGE_PORT=8099
//
// Endpoints (proxied by bin/serve.js under /api/ib/*):
//   GET /status                         → connection + mode info
//   GET /history?symbol=EURUSD=X&tf=1m  → { candles:[{t,o,h,l,c,v}] }
//   GET /quotes?symbols=AAPL,EURUSD=X   → { quotes:{sym:{price,bid,ask,t}} }
//   GET /candles?symbols=AAPL           → { candles:{sym:{t,o,h,l,c,v}}} (current 1m bar)
//
// Notes:
//  - FX → IDEAL_PRO CASH contracts (MIDPOINT); US stocks → SMART/USD (TRADES).
//  - Indices (^GSPC) and futures (GC=F) are not mapped; the app uses Yahoo.
//  - Historical requests are cached 60s and coalesced (IB pacing limits).
//  - The bridge retries every 15s and auto-picks whichever IB API port appears.
// ────────────────────────────────────────────────────────────────────

import http from "node:http";
import net from "node:net";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { IBApi, EventName, Forex, Stock, BarSizeSetting } = require("@stoqey/ib");

const HOST = process.env.IB_HOST || "127.0.0.1";
const FORCED_PORT = process.env.IB_PORT ? Number(process.env.IB_PORT) : null;
const CLIENT_ID = Number(process.env.IB_CLIENT_ID || 32);
const BRIDGE_PORT = Number(process.env.IB_BRIDGE_PORT || 8099);
const DATA_TYPE = Number(process.env.IB_DATA_TYPE || 1);
const CANDIDATE_PORTS = FORCED_PORT ? [FORCED_PORT] : [4001, 4002, 7496, 7497];

const modeName = (port) => (port === 4001 || port === 7496 ? "live" : "paper");

const state = {
  connected: false,
  connecting: false,
  port: FORCED_PORT ?? CANDIDATE_PORTS[0],
  lastError: null,
  ib: null,
  quotes: new Map(),      // symbol → { price, bid, ask, mid, t }
  liveBars: new Map(),    // symbol → current 1m bar
  historical: new Map(),  // reqId → { symbol, tf, resolve, reject, timer, candles }
  historyCache: new Map(),// "SYM|tf" → { at, candles }
};

let nextReqId = 1000;
let nextTickerId = 1;
const tickerIds = new Map();  // tickerId → symbol
const symbolTickers = new Map(); // symbol → tickerId
const contractCache = new Map();

function log(msg) { console.log(`[ib] ${msg}`); }

let lastLogAt = 0;
let lastLogMsg = "";
function logThrottled(msg, ms = 30_000) {
  const now = Date.now();
  if (msg === lastLogMsg && now - lastLogAt < ms) return;
  lastLogMsg = msg;
  lastLogAt = now;
  log(msg);
}

// ─── contracts ──────────────────────────────────────────────────────
function contractFor(symbol) {
  const sym = String(symbol || "").toUpperCase().trim();
  if (contractCache.has(sym)) return contractCache.get(sym);
  let contract = null;
  const fx = /^([A-Z]{3})([A-Z]{3})=X$/.exec(sym);
  if (fx) contract = new Forex(fx[1], fx[2]);
  else if (/^[A-Z][A-Z0-9.\-]{0,9}$/.test(sym) && !sym.endsWith("-USD")) {
    contract = new Stock(sym, "SMART", "USD");
  }
  contractCache.set(sym, contract);
  return contract;
}
const isFx = (symbol) => /^[A-Z]{6}=X$/.test(String(symbol).toUpperCase());

// ─── timeframe mapping ──────────────────────────────────────────────
const TF_MAP = {
  "1m": { bar: BarSizeSetting.MINUTES_ONE, duration: "1 D" },
  "5m": { bar: BarSizeSetting.MINUTES_FIVE, duration: "2 D" },
  "15m": { bar: BarSizeSetting.MINUTES_FIFTEEN, duration: "5 D" },
  "30m": { bar: BarSizeSetting.MINUTES_THIRTY, duration: "10 D" },
  "1h": { bar: BarSizeSetting.HOURS_ONE, duration: "1 M" },
  "4h": { bar: BarSizeSetting.HOURS_FOUR, duration: "3 M" },
  "1D": { bar: BarSizeSetting.DAYS_ONE, duration: "2 Y" },
  "1W": { bar: BarSizeSetting.WEEKS_ONE, duration: "5 Y" },
  "1M": { bar: BarSizeSetting.MONTHS_ONE, duration: "10 Y" },
  // internal: 5-second bars, used to backfill FX tick-volume counts
  "5s": { bar: BarSizeSetting.SECONDS_FIVE, duration: "7200 S" },
};

// ─── IB client lifecycle ────────────────────────────────────────────
function createClient(port) {
  const ib = new IBApi({ host: HOST, port, clientId: CLIENT_ID });

  ib.on(EventName.connected, () => {
    if (ib !== state.ib) return;
    state.connected = true;
    state.connecting = false;
    state.lastError = null;
    log(`connected → ${HOST}:${port} (${modeName(port)}) clientId=${CLIENT_ID}`);
    try { ib.reqMarketDataType(DATA_TYPE); } catch { /* older gateway */ }
    for (const sym of state.quotes.keys()) subscribeMarketData(ib, sym);
  });

  ib.on(EventName.disconnected, () => {
    if (ib !== state.ib) return;
    state.connected = false;
    state.connecting = false;
    logThrottled("disconnected — retrying");
  });

  ib.on(EventName.error, (err, code, reqId) => {
    if (ib !== state.ib) return;
    const c = Number(code);
    const msg = err?.message ?? String(err);
    if ([2104, 2106, 2158, 2108].includes(c)) return; // farm status OK
    if (c === 10167 || c === 10168) {
      state.lastError = "market data not subscribed — try IB_DATA_TYPE=3 (delayed)";
      logThrottled(state.lastError, 120_000);
      return;
    }
    state.lastError = `${c}: ${msg}`;
    logThrottled(`error ${c}: ${msg}`, 60_000);
    if (reqId != null) {
      const h = state.historical.get(reqId);
      if (h) finishHistorical(reqId, new Error(msg));
    }
  });

  ib.on(EventName.historicalData, (reqId, date, open, high, low, close, volume) => {
    if (ib !== state.ib) return;
    const h = state.historical.get(reqId);
    if (!h) return;
    if (Number(open) === -1) { finishHistorical(reqId); return; } // completion marker
    const t = Number(date) * 1000;
    const o = Number(open), hi = Number(high), lo = Number(low), c = Number(close);
    if (!Number.isFinite(t) || ![o, hi, lo, c].every(Number.isFinite)) return;
    h.candles.push({ t, o, h: hi, l: lo, c, v: Math.max(0, Number(volume) || 0) });
  });

  ib.on(EventName.tickPrice, (tickerId, tickType, price) => {
    if (ib !== state.ib) return;
    const symbol = tickerIds.get(tickerId);
    if (!symbol || !Number.isFinite(price) || price <= 0) return;
    switch (tickType) {
      case 1: case 66: updateLiveQuote(symbol, { bid: price }); break;   // BID / DELAYED_BID
      case 2: case 67: updateLiveQuote(symbol, { ask: price }); break;   // ASK / DELAYED_ASK
      case 4: case 68: updateLiveQuote(symbol, { price }); break;        // LAST / DELAYED_LAST
      default: break;
    }
  });

  return ib;
}

function finishHistorical(reqId, err) {
  const h = state.historical.get(reqId);
  if (!h) return;
  clearTimeout(h.timer);
  state.historical.delete(reqId);
  if (err) h.reject(err);
  else {
    if (h.cache !== false) state.historyCache.set(`${h.symbol}|${h.tf}`, { at: Date.now(), candles: h.candles });
    state.lastError = null;
    h.resolve(h.candles);
  }
  // only abort on failure — cancelling a finished request makes IB emit error 366
  if (err) { try { state.ib?.cancelHistoricalData(reqId); } catch { /* ignore */ } }
}

// ─── market data ────────────────────────────────────────────────────
function subscribeMarketData(ib, symbol) {
  if (symbolTickers.has(symbol)) return;
  const contract = contractFor(symbol);
  if (!contract) return;
  const id = nextTickerId++;
  tickerIds.set(id, symbol);
  symbolTickers.set(symbol, id);
  try { ib.reqMktData(id, contract, "", false, false); }
  catch (err) { state.lastError = `reqMktData ${symbol}: ${err?.message ?? err}`; }
}

function updateLiveQuote(symbol, patch) {
  const cur = state.quotes.get(symbol) ?? { price: null, bid: null, ask: null, mid: null, t: 0 };
  Object.assign(cur, patch, { t: Date.now() });
  let price = Number.isFinite(cur.price) ? cur.price : null;
  if (price === null && Number.isFinite(cur.bid) && Number.isFinite(cur.ask)) price = (cur.bid + cur.ask) / 2;
  if (price !== null && Number.isFinite(price)) {
    cur.mid = price;
    const bucket = Math.floor(Date.now() / 60_000) * 60_000;
    const bar = state.liveBars.get(symbol);
    if (!bar || bar.t !== bucket) {
      state.liveBars.set(symbol, { t: bucket, o: price, h: price, l: price, c: price, v: 1 });
    } else {
      if (price > bar.h) bar.h = price;
      if (price < bar.l) bar.l = price;
      bar.c = price;
      // spot FX has no volume; count ticks as an honest activity proxy
      bar.v = (Number(bar.v) || 0) + 1;
    }
  }
  state.quotes.set(symbol, cur);
}

// ─── history ────────────────────────────────────────────────────────
const TF_BUCKET_MS = {
  "1m": 60_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000,
  "1h": 3_600_000, "4h": 14_400_000,
};

function requestBars(symbol, durationStr, barSize, whatToShow, useRTH, label, cache = true) {
  const contract = contractFor(symbol);
  if (!contract) return Promise.reject(new Error(`unsupported symbol: ${symbol}`));
  const ib = state.ib;
  if (!ib || !state.connected) return Promise.reject(new Error("IB gateway not connected"));
  const reqId = nextReqId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finishHistorical(reqId, new Error("IB historical timeout")), 30_000);
    state.historical.set(reqId, { symbol, tf: label, cache, resolve, reject, timer, candles: [] });
    try {
      ib.reqHistoricalData(reqId, contract, "", durationStr, barSize, whatToShow, useRTH, 2, false);
    } catch (err) { finishHistorical(reqId, err); }
  });
}

/** Recent 5-second bars (cached) used to derive FX tick-volume counts. */
let fiveSecChain = Promise.resolve();
const tickVolumeCache = new Map(); // symbol ? { at, map: minuteTs ? moved 5s bars }

function getTickVolumeMap(symbol) {
  const cached = tickVolumeCache.get(symbol);
  if (cached && Date.now() - cached.at < 300_000) return Promise.resolve(cached.map);
  const run = async () => {
    let bars;
    try {
      bars = await requestBars(symbol, TF_MAP["5s"].duration, BarSizeSetting.SECONDS_FIVE, "MIDPOINT", 0, "5s", false);
    } catch {
      // IB sometimes cancels a heavy historical query (162/100x) — retry once
      await new Promise((r) => setTimeout(r, 2000));
      bars = await requestBars(symbol, TF_MAP["5s"].duration, BarSizeSetting.SECONDS_FIVE, "MIDPOINT", 0, "5s", false);
    }
    const map = new Map();
    for (const b of bars) {
      const moved = b.h !== b.l || b.c !== b.o;
      const minute = Math.floor(b.t / 60_000) * 60_000;
      map.set(minute, (map.get(minute) || 0) + (moved ? 1 : 0));
    }
    tickVolumeCache.set(symbol, { at: Date.now(), map });
    for (const k of [...state.historyCache.keys()]) if (k.startsWith(`${symbol}|`)) state.historyCache.delete(k);
    return map;
  };
  const p = fiveSecChain.then(run, run);
  fiveSecChain = p.then(() => undefined, () => undefined);
  return p;
}

function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise((resolve) => { setTimeout(() => resolve(fallback), ms).unref?.(); }),
  ]);
}

/**
 * Spot FX has no traded volume: approximate TradingView-style tick volume by
 * counting how many 5-second bars actually moved inside each candle.
 */
function applyTickVolume(candles, minuteMoves, bucketMs) {
  if (!minuteMoves || minuteMoves.size === 0) return;
  for (const c of candles) {
    let sum = 0;
    for (let m = c.t; m < c.t + bucketMs; m += 60_000) sum += minuteMoves.get(m) || 0;
    c.v = sum;
  }
}

function getHistory(symbol, tf) {
  const key = `${symbol}|${tf}`;
  const cached = state.historyCache.get(key);
  if (cached && Date.now() - cached.at < (cached.ttl ?? 60_000)) return Promise.resolve(cached.candles);
  const spec = TF_MAP[tf];
  const bucket = TF_BUCKET_MS[tf];
  if (!contractFor(symbol) || !spec) return Promise.reject(new Error(`unsupported symbol/timeframe: ${symbol} ${tf}`));

  return requestBars(
    symbol, spec.duration, spec.bar,
    isFx(symbol) ? "MIDPOINT" : "TRADES",
    isFx(symbol) ? 0 : 1,
    tf,
    false,
  ).then(async (candles) => {
    let ttl = 60_000;
    if (isFx(symbol) && bucket) {
      const known = tickVolumeCache.get(symbol);
      const map = known && Date.now() - known.at < 300_000
        ? known.map
        : await withTimeout(getTickVolumeMap(symbol).catch(() => null), 8000, null);
      if (map) applyTickVolume(candles, map, bucket);
      else ttl = 10_000;
    }
    state.historyCache.set(key, { at: Date.now(), candles, ttl });
    return candles;
  });
}
function probePort(port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: HOST, port });
    const done = (ok) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function connect() {
  if (state.connected || state.connecting) return;
  state.connecting = true;
  try {
    let port = FORCED_PORT;
    if (!port) {
      for (const p of CANDIDATE_PORTS) {
        if (await probePort(p)) { port = p; break; }
      }
    }
    if (!port) {
      logThrottled(`no IB gateway listening on ${CANDIDATE_PORTS.join("/")} — start TWS or IB Gateway and enable the API`, 60_000);
      state.connecting = false;
      return;
    }
    if (!state.ib || state.port !== port) {
      try { state.ib?.disconnect(); } catch { /* ignore */ }
      tickerIds.clear();
      symbolTickers.clear();
      state.port = port;
      state.ib = createClient(port);
      logThrottled(`connecting to ${HOST}:${port} (${modeName(port)})…`);
    }
    state.ib.connect();
    // if handshake stalls, allow a retry
    setTimeout(() => { if (!state.connected) state.connecting = false; }, 8000).unref?.();
  } catch (err) {
    state.connecting = false;
    state.lastError = String(err?.message ?? err);
    logThrottled(`connect failed: ${state.lastError}`, 30_000);
  }
}

// ─── HTTP API ───────────────────────────────────────────────────────
function json(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  void (async () => {
    try {
      const url = new URL(req.url || "/", "http://localhost");
      const path = url.pathname;

      if (path === "/status") {
        return json(res, 200, {
          connected: state.connected,
          host: HOST,
          port: state.port,
          mode: modeName(state.port),
          clientId: CLIENT_ID,
          marketDataType: DATA_TYPE,
          symbols: [...symbolTickers.keys()],
          lastError: state.lastError,
        });
      }

      if (path === "/history") {
        const symbol = String(url.searchParams.get("symbol") || "").toUpperCase();
        const tf = String(url.searchParams.get("tf") || "1m");
        if (!contractFor(symbol)) return json(res, 400, { error: `IB cannot serve ${symbol}` });
        if (!state.connected) return json(res, 503, { error: "IB gateway not connected" });
        try {
          const candles = await getHistory(symbol, tf);
          subscribeMarketData(state.ib, symbol);
          return json(res, 200, { source: "ib", candles });
        } catch (err) {
          return json(res, 502, { error: err?.message ?? String(err) });
        }
      }

      if (path === "/quotes") {
        const symbols = String(url.searchParams.get("symbols") || "")
          .split(",").map((s) => s.trim().toUpperCase()).filter(Boolean).slice(0, 60);
        const quotes = {};
        for (const sym of symbols) {
          if (!contractFor(sym)) continue;
          if (state.connected) subscribeMarketData(state.ib, sym);
          const q = state.quotes.get(sym);
          if (q && Number.isFinite(q.mid)) quotes[sym] = { price: q.mid, bid: q.bid, ask: q.ask, t: q.t };
        }
        return json(res, 200, { connected: state.connected, quotes });
      }

      if (path === "/candles") {
        const symbols = String(url.searchParams.get("symbols") || "")
          .split(",").map((s) => s.trim().toUpperCase()).filter(Boolean).slice(0, 60);
        const candles = {};
        for (const sym of symbols) {
          if (!contractFor(sym)) continue;
          if (state.connected) subscribeMarketData(state.ib, sym);
          const bar = state.liveBars.get(sym);
          if (bar) candles[sym] = bar;
        }
        return json(res, 200, { connected: state.connected, candles });
      }

      json(res, 404, { error: "not found" });
    } catch (err) {
      json(res, 500, { error: String(err?.message ?? err) });
    }
  })();
});

server.listen(BRIDGE_PORT, "127.0.0.1", () => {
  log(`bridge on http://127.0.0.1:${BRIDGE_PORT}`);
  log(`gateway: ${HOST} · ports ${CANDIDATE_PORTS.join(", ")} · clientId ${CLIENT_ID} · dataType ${DATA_TYPE}`);
  log("waiting for TWS / IB Gateway (API must be enabled)…");
});

connect();
setInterval(connect, 15_000).unref?.();

function shutdown() {
  try { state.ib?.disconnect(); } catch { /* ignore */ }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref?.();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
