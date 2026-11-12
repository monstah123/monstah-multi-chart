import type { Candle } from "./types.js";

// ─── EMA ──────────────────────────────────────────────────────────────
export function emaSeries(input: readonly number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array<number | null>(input.length).fill(null);
  if (input.length === 0) return out;
  const k = 2 / (period + 1);
  let prev = input[0];
  out[0] = prev;
  for (let i = 1; i < input.length; i++) {
    prev = input[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  for (let i = 0; i < Math.min(period - 1, input.length); i++) out[i] = null;
  return out;
}

// ─── SMA ──────────────────────────────────────────────────────────────
export function smaSeries(input: readonly number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array<number | null>(input.length).fill(null);
  if (input.length < period) return out;
  let sum = 0;
  for (let i = 0; i < input.length; i++) {
    sum += input[i];
    if (i >= period) sum -= input[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

// ─── RSI (Wilder) ─────────────────────────────────────────────────────
export function rsiSeries(closes: readonly number[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array<number | null>(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gain = 0, loss = 0;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = Math.max(d, 0);
    const l = Math.max(-d, 0);
    if (i <= period) {
      gain += g; loss += l;
      if (i === period) {
        avgGain = gain / period; avgLoss = loss / period;
        out[i] = 100 - 100 / (1 + avgGain / (avgLoss || 1e-12));
      }
    } else {
      avgGain = (avgGain * (period - 1) + g) / period;
      avgLoss = (avgLoss * (period - 1) + l) / period;
      out[i] = 100 - 100 / (1 + avgGain / (avgLoss || 1e-12));
    }
  }
  return out;
}

// ─── MACD ─────────────────────────────────────────────────────────────
export interface MacdResult {
  macd:   (number | null)[];
  signal: (number | null)[];
  hist:   (number | null)[];
}

export function macdSeries(closes: readonly number[], fast = 12, slow = 26, sig = 9): MacdResult {
  const emaFast = emaSeries(closes, fast);
  const emaSlow = emaSeries(closes, slow);
  const macdLine: (number | null)[] = new Array<number | null>(closes.length).fill(null);
  for (let i = 0; i < closes.length; i++) {
    if (emaFast[i] !== null && emaSlow[i] !== null) macdLine[i] = (emaFast[i] as number) - (emaSlow[i] as number);
  }
  const packed: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i < macdLine.length; i++) {
    if (macdLine[i] !== null) { packed.push(macdLine[i] as number); idx.push(i); }
  }
  const signalPacked = emaSeries(packed, sig);
  const signal: (number | null)[] = new Array<number | null>(closes.length).fill(null);
  for (let i = 0; i < signalPacked.length; i++) {
    if (signalPacked[i] !== null) signal[idx[i]] = signalPacked[i] as number;
  }
  const hist: (number | null)[] = new Array<number | null>(closes.length).fill(null);
  for (let i = 0; i < closes.length; i++) {
    if (macdLine[i] !== null && signal[i] !== null) hist[i] = (macdLine[i] as number) - (signal[i] as number);
  }
  return { macd: macdLine, signal, hist };
}

// Convenience aggregate for a candle series → typed indicators
export interface CandleIndicators {
  sma10: (number | null)[];
  sma30: (number | null)[];
  ema12: (number | null)[];
  macd:  MacdResult;
  rsi:   (number | null)[];
}

export function computeAll(candles: readonly Candle[]): CandleIndicators {
  const closes = candles.map((c) => c.c);
  return {
    sma10: smaSeries(closes, 10),
    sma30: smaSeries(closes, 30),
    ema12: emaSeries(closes, 12),
    macd:  macdSeries(closes, 12, 26, 9),
    rsi:   rsiSeries(closes, 14),
  };
}
