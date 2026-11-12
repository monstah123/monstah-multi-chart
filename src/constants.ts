import type { Timeframe } from "./types.js";

export const TF: { key: Timeframe; label: string; binance: string; yahoo: { interval: string; range: string } }[] = [
  // 1m: Yahoo returns only the last ~7 minutes for range=1d on stocks — 5d gives
  // the full multi-session minute series (verified for stocks, ETFs, indices, FX, futures).
  { key: "1m",  label: "1m",  binance: "1m",  yahoo: { interval: "1m",  range: "5d" } },
  { key: "5m",  label: "5m",  binance: "5m",  yahoo: { interval: "5m",  range: "5d" } },
  { key: "15m", label: "15m", binance: "15m", yahoo: { interval: "15m", range: "5d" } },
  { key: "30m", label: "30m", binance: "30m", yahoo: { interval: "30m", range: "1mo" } },
  { key: "1h",  label: "1H",  binance: "1h",  yahoo: { interval: "60m", range: "1mo" } },
  { key: "4h",  label: "4H",  binance: "4h",  yahoo: { interval: "60m", range: "3mo" } }, // yahoo lacks 4h → fall back to 1h
  { key: "1D",  label: "D",   binance: "1d",  yahoo: { interval: "1d",  range: "2y"  } },
  { key: "1W",  label: "W",   binance: "1w",  yahoo: { interval: "1wk", range: "5y"  } },
  { key: "1M",  label: "M",   binance: "1M",  yahoo: { interval: "1mo", range: "max" } },
];

export const DEFAULT_SYMBOLS: string[] = [
  // crypto (Binance live)
  "BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT","ADAUSDT","DOGEUSDT","AVAXUSDT","DOTUSDT",
  // crypto pairs (Binance)
  "SOLBTC","BNBBTC","ETHBTC",
  // stocks (Yahoo)
  "AAPL","MSFT","NVDA","TSLA","AMZN","GOOG","META","IBM","ORCL","AMD",
  // ETFs (Yahoo)
  "SPY","QQQ","DIA","IWM","ARKK","VOO","GLD","SLV",
  // indices (Yahoo)
  "^GSPC","^DJI","^IXIC","^RUT","^VIX",
  // FX (Yahoo)
  "EURUSD=X","GBPUSD=X","USDJPY=X","AUDUSD=X","USDCAD=X","NZDUSD=X",
  // commodities (Yahoo)
  "GC=F","CL=F","SI=F","NG=F",
];

export const SYMBOL_GROUPS: { group: string; symbols: string[] }[] = [
  { group: "Crypto — Binance LIVE", symbols: ["BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT","ADAUSDT","DOGEUSDT","AVAXUSDT","DOTUSDT"] },
  { group: "Crypto pairs (Binance)", symbols: ["SOLBTC","BNBBTC","ETHBTC"] },
  { group: "Stocks — Yahoo delayed", symbols: ["AAPL","MSFT","NVDA","TSLA","AMZN","GOOG","META","IBM","ORCL","AMD"] },
  { group: "ETFs — Yahoo delayed", symbols: ["SPY","QQQ","DIA","IWM","ARKK","VOO","GLD","SLV"] },
  { group: "Indices — Yahoo delayed", symbols: ["^GSPC","^DJI","^IXIC","^RUT","^VIX"] },
  { group: "FX — Yahoo delayed", symbols: ["EURUSD=X","GBPUSD=X","USDJPY=X","AUDUSD=X","USDCAD=X","NZDUSD=X"] },
  { group: "Commodities — Yahoo delayed", symbols: ["GC=F","CL=F","SI=F","NG=F"] },
];

export const INDICATOR_COLORS = {
  sma10: "#ffd200",
  sma30: "#3b7bff",
  ema12: "#b57bff",
  macd:  "#ff7a18",
  macdSignal: "#4dc3ff",
  macdHistUp: "#26a69a",
  macdHistDown: "#ef5350",
  rsi:   "#ffb86c",
};

export const STORAGE_KEY_LAYOUT = "multi-chart:layout:v1";
export const MAX_BARS = 2000;
// Panes whose data source is Yahoo get a short auto-poll instead of nothing;
// Binance panes keep the true live WebSocket. Yahoo freshness varies: near-real-time in active sessions, may lag minutes off-hours.
export const YAHOO_POLL_MS = 5000;
