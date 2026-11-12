export interface Candle {
  t: number;   // timestamp ms (open time)
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;  // volume (Binance) or shares (Yahoo)
}

export type Timeframe = "1m" | "5m" | "15m" | "30m" | "1h" | "4h" | "1D" | "1W" | "1M";

export interface PaneSpec {
  id: number;
  symbol: string;
  timeframe: Timeframe;
}

export type OscillatorMode = "rsi" | "macd" | "off";
