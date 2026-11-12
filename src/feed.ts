// ────────────────────────────────────────────────────────────────────
// DataFeed — unified OHLCV loading for Binance (live + history)
//                and Yahoo Finance (snapshot via local proxy)
// Endpoint policy:
//   Binance direct from browser is CORS-enabled (documented public API)
//   Yahoo is proxied through bin/serve.js to avoid CORS failures
// No API key required anywhere.
// ────────────────────────────────────────────────────────────────────

import { TF, MAX_BARS } from "./constants.js";
import type { Candle, Timeframe } from "./types.js";

export interface LoadResult {
  source: "binance" | "ib" | "yahoo";
  candles: Candle[];
  note: string;
}

// ─── helpers ─────────────────────────────────────────────────────────

function binanceInterval(tf: Timeframe): string {
  const hit = TF.find((t) => t.key === tf);
  if (!hit) throw new Error("unknown timeframe: " + tf);
  return hit.binance;
}

function yahooQuery(tf: Timeframe): { interval: string; range: string } {
  const hit = TF.find((t) => t.key === tf);
  if (!hit) throw new Error("unknown timeframe: " + tf);
  return hit.yahoo;
}

// ─── symbol classification ────────────────────────────────────────────

export function isBinanceSymbol(symbol: string): boolean {
  // Binance spot pairs: a base asset (≥3 chars, e.g. SOL in SOLBTC) followed by a
  // major quote asset. The base-length guard keeps US tickers ending in "BTC"
  // (e.g. GBTC) on the stock path. Previously USDT-only, which misrouted legit
  // Binance pairs (SOLBTC/BNBBTC/ETHBTC) into the IB bucket.
  const s = symbol.trim().toUpperCase();
  return /^([A-Z0-9]{3,})(USDT|USDC|FDUSD|TUSD|PYUSD|BTC|ETH|BNB)$/.test(s);
}

// ─── Interactive Brokers bridge (optional, local) ─────────────────────

/**
 * Symbols the IB bridge is used for: FX pairs only.
 * (US stock streaming requires a paid API market-data subscription — IB
 * returns error 10089 without it — so stocks stay on Yahoo.)
 */
export function isIbSymbol(symbol: string): boolean {
  const s = symbol.trim().toUpperCase();
  // IB bridge regex matches exactly what contractFor expects in ib-bridge.js
  return /^([A-Z]{3})([A-Z]{3})=X$/.test(s);
}

let ibStatusCache: { at: number; connected: boolean } = { at: 0, connected: false };

export async function isIbAvailable(): Promise<boolean> {
  if (Date.now() - ibStatusCache.at < 15000) return ibStatusCache.connected;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    const r = await fetch("/api/ib/status", { signal: ctrl.signal, cache: "no-store" });
    clearTimeout(timer);
    if (!r.ok) throw new Error("bridge down");
    const j = (await r.json()) as { connected?: boolean };
    ibStatusCache = { at: Date.now(), connected: !!j.connected };
  } catch {
    ibStatusCache = { at: Date.now(), connected: false };
  }
  return ibStatusCache.connected;
}

export async function loadIbHistory(symbol: string, tf: Timeframe): Promise<Candle[]> {
  const url = `/api/ib/history?symbol=${encodeURIComponent(symbol.toUpperCase())}&tf=${encodeURIComponent(tf)}`;
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    throw new Error(`IB bridge ${r.status}: ${detail.slice(0, 160)}`);
  }
  const j = (await r.json()) as { candles?: Candle[] };
  return Array.isArray(j.candles) ? j.candles : [];
}

/** Latest live 1-minute bar aggregated by the bridge from IB ticks. */
export async function loadIbCandles(symbol: string): Promise<Candle[]> {
  const r = await fetch(`/api/ib/candles?symbols=${encodeURIComponent(symbol.toUpperCase())}`, { cache: "no-store" });
  if (!r.ok) return [];
  const j = (await r.json()) as { candles?: Record<string, Candle> };
  const bar = j.candles?.[symbol.toUpperCase()];
  return bar && Number.isFinite(bar.c) ? [bar] : [];
}

// ─── Binance ─────────────────────────────────────────────────────────

async function fetchBinanceHistory(symbol: string, tf: Timeframe, limit = 500): Promise<Candle[]> {
  const interval = binanceInterval(tf);
  const url =
    "https://api.binance.com/api/v3/klines" +
    `?symbol=${encodeURIComponent(symbol.toUpperCase())}&interval=${interval}&limit=${Math.min(limit, 1000)}`;
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`Binance REST ${r.status}: ${r.statusText}`);
  const rows = (await r.json()) as (string | number)[][];
  return rows.map((k) => ({
    t: Number(k[0]),
    o: Number(k[1]),
    h: Number(k[2]),
    l: Number(k[3]),
    c: Number(k[4]),
    v: Number(k[5]),
  }));
}

export function openBinanceKlineStream(
  symbol: string,
  tf: Timeframe,
  onUpdate: (update: Candle & { closed: boolean }) => void,
): { close: () => void } {
  const interval = binanceInterval(tf);
  const lower = symbol.toLowerCase();
  const ws = new WebSocket(`wss://stream.binance.com:9443/ws/${lower}@kline_${interval}`);
  ws.onmessage = (evt) => {
    try {
      const data = JSON.parse(String(evt.data)) as { e?: string; k?: { t: number; o: string; h: string; l: string; c: string; v: string; x: boolean } };
      if (!data || data.e !== "kline" || !data.k) return;
      const k = data.k;
      onUpdate({
        t: Number(k.t),
        o: Number(k.o), h: Number(k.h), l: Number(k.l), c: Number(k.c), v: Number(k.v),
        closed: !!k.x,
      });
    } catch { /* malformed frame — skip silently */ }
  };
  ws.onerror = () => { /* WS unavailable — history data remains */ };
  return { close: () => { try { ws.close(); } catch { /* already closed */ } } };
}

// ─── Yahoo Finance (via local proxy) ──────────────────────────────────

interface YahooQuote { open?: (number | null)[]; high?: (number | null)[]; low?: (number | null)[]; close?: (number | null)[]; volume?: (number | null)[] }
interface YahooChartResponse {
  chart?: {
    result?: Array<{
      timestamp?: number[];
      indicators?: { quote?: YahooQuote[] };
    }>;
  };
}

async function fetchYahooHistory(symbol: string, tf: Timeframe, rangeOverride?: string): Promise<Candle[]> {
  const { interval, range } = yahooQuery(tf);
  const rng = rangeOverride ?? range;
  const getChart = async (sym: string): Promise<YahooChartResponse | null> => {
    const url = `/api/yahoo-history?symbol=${encodeURIComponent(sym)}&interval=${interval}&range=${rng}`;
    try {
      const r = await fetch(url, { cache: "no-store" });
      return r.ok ? ((await r.json()) as YahooChartResponse) : null;
    } catch {
      return null;
    }
  };
  let body = await getChart(symbol);
  if (!body?.chart?.result?.[0]?.timestamp?.length && symbol.includes(".")) {
    // Yahoo stores US class shares with a dash (BRK.B → BRK-B)
    body = await getChart(symbol.replace(/\./g, "-"));
  }
  const block = body?.chart?.result?.[0];
  if (!block?.timestamp?.length) throw new Error("Yahoo returned no chart data for " + symbol);
  const open = block.indicators?.quote?.[0]?.open ?? [];
  const high = block.indicators?.quote?.[0]?.high ?? [];
  const low = block.indicators?.quote?.[0]?.low ?? [];
  const close = block.indicators?.quote?.[0]?.close ?? [];
  const vol = block.indicators?.quote?.[0]?.volume ?? [];
  const out: Candle[] = [];
  const isFx = /^[A-Z]{6}=X$/i.test(symbol);
  const expandFxShapes = isFx && ["1m", "5m", "15m", "30m"].includes(interval);
  const dropPlaceholders = !isFx && ["1m", "5m", "15m", "30m"].includes(interval);
  for (let i = 0; i < block.timestamp.length; i++) {
    const o = open[i], h = high[i], l = low[i], c = close[i], v = vol[i] ?? 0;
    if (o == null || h == null || l == null || c == null) continue;
    // Yahoo zero-fills closed periods (weekends, overnight, halts) with flat
    // bars at volume 0 — they are placeholders, not trades. Drop them so the
    // intraday chart shows real bars only (like a non-trading-gap skip).
    if (dropPlaceholders && v === 0 && o === h && h === l && l === c) continue;
    out.push({ t: block.timestamp[i] * 1000, o, h, l, c, v });
  }
  // FX last-price flats: expand to *visible* synthetic bodies with a
  // deterministic pip-scale hash (display re-construction requested by the
  // user — Yahoo FX reports no real OHLC and IB has no historical FX
  // permission). NOT real range data: no angle sizing, no claim of history.
  if (expandFxShapes) expandFxFlats(out);
  return out;
}

/** Deterministic synthetic-shape expansion of flat FX bars (see call site). */
function expandFxFlats(candles: Candle[]): void {
  const hash = (n: number): number => {
    const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return s - Math.floor(s);
  };
  for (const c of candles) {
    if (!(c.o === c.h && c.h === c.l && c.l === c.c && (c.v ?? 0) === 0)) continue;
    const p = c.c;
    const seed = c.t / 60_000;
    const r1 = hash(seed), r2 = hash(seed + 0.618), r3 = hash(seed + 1.317);
    // pip-scale half range — a few points of FX price; deterministic per bar.
    const halfSpan = p * 0.0009 * (0.4 + r1 * 1.1);
    const bodyHalf = halfSpan * (0.45 + r2 * 0.4);
    const dirUp = r3 < 0.5;
    c.o = dirUp ? p - bodyHalf : p + bodyHalf;
    c.c = dirUp ? p + bodyHalf : p - bodyHalf;
    const wickTop = p + halfSpan * (0.6 + r2 * 0.9);
    const wickBot = p - halfSpan * (0.6 + r3 * 0.9);
    c.h = Math.max(wickTop, c.o, c.c);
    c.l = Math.min(wickBot, c.o, c.c);
    c.v = 0;
  }
}

/** Load full history for a (symbol, timeframe) pair. Routes to Binance, IB or Yahoo. */
export async function loadHistory(symbol: string, tf: Timeframe): Promise<LoadResult> {
  const s = symbol.trim().toUpperCase();
  if (isBinanceSymbol(s) && !s.startsWith("^")) {
    const candles = await fetchBinanceHistory(s, tf, MAX_BARS);
    return { source: "binance", candles, note: "Binance REST (history) · WebSocket (live)" };
  }
  // prefer the local IB bridge (live FX + live US stocks) when it's connected
  if (isIbSymbol(s) && (await isIbAvailable())) {
    try {
      const candles = await loadIbHistory(s, tf);
      if (candles.length > 0) {
        return { source: "ib", candles, note: "Interactive Brokers (live via TWS/IB Gateway)" };
      }
    } catch { /* bridge error — fall back to Yahoo */ }
  }
  const candles = await fetchYahooHistory(s, tf);
  return { source: "yahoo", candles, note: "Yahoo Finance (snapshot via local proxy)" };
}

/**
 * Lightweight Yahoo refresh for polling: intraday timeframes ask only for the
 * current session (range=1d) so the poll payload stays small; the pane merges
 * the returned bars into its existing history instead of replacing it.
 */
export async function loadYahooRefresh(symbol: string, tf: Timeframe): Promise<Candle[]> {
  const s = symbol.trim().toUpperCase();
  const intraday = tf === "1m" || tf === "5m" || tf === "15m" || tf === "30m" || tf === "1h" || tf === "4h";
  return fetchYahooHistory(s, tf, intraday ? "1d" : undefined);
}
