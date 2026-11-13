// ────────────────────────────────────────────────────────────────────
// ChartPane — one independent pane.
//   header: symbol · timeframe · live price · oscillator · close
//   canvas: candles + wicks + SMA/EMA overlays + volume strip + RSI/MACD
//   interactive: wheel-zoom, drag-pan, resize-aware
// ────────────────────────────────────────────────────────────────────

import type { Candle, OscillatorMode, Timeframe } from "./types.js";
import { MAX_BARS, YAHOO_POLL_MS } from "./constants.js";
import { computeAll } from "./indicators.js";
import { loadHistory, loadYahooRefresh, loadIbCandles, loadIbHistory, isBinanceSymbol, openBinanceKlineStream } from "./feed.js";
import { listShapes, saveShapes, hitTest, drawShape, newShapeId, CLICK_COUNT, DRAG_TOOLS } from "./drawtools.js";
import { palette } from "./theme.js";
import type { Shape, ToolId, Anchor, DrawCtx } from "./drawtools.js";
import { listAlerts, addAlert, removeAlert, checkPrice, ensureNotificationPermission } from "./alerts.js";
import type { PriceAlert } from "./alerts.js";

export interface PaneCallbacks {
  onStatus: (msg: string) => void;
  onRemoved: (id: number) => void;
  /** fired after a drawing is committed — let the host reset back to cursor mode */
  onToolDone?: (id: number) => void;
}

const PRICE_AXIS_W = 90;
const DEFAULT_FUTURE_BARS = 3;   // right margin so the newest candle is never clipped
const MAX_FUTURE_BARS = 120;     // how far you can scroll past the newest candle
const FONT_DIM = "10px -apple-system, 'Segoe UI', Roboto, sans-serif";
const TF_MS: Record<string, number> = {
  "1m": 60_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000, "1h": 3_600_000, "4h": 14_400_000,
};

export class ChartPane {
  readonly id: number;
  symbol: string;
  timeframe: Timeframe;
  oscMode: OscillatorMode = "rsi";

  wrap!: HTMLElement;
  headerEl!: HTMLElement;
  canvas!: HTMLCanvasElement;
  priceEl!: HTMLElement;
  private ctx!: CanvasRenderingContext2D;
  private tfSelect!: HTMLSelectElement;
  private expandBtn!: HTMLButtonElement;
  private symbolEl!: HTMLElement;
  private fsBadge: HTMLElement | null = null;
  private fullscreen = false;
  private hscrollEl!: HTMLDivElement;
  private hscrollInput!: HTMLInputElement;

  private candles: Candle[] = [];
  private indicator: ReturnType<typeof computeAll> | null = null;
  private visibleBars = 160;
  private offsetBars = 0;
  /** empty bars kept to the right of the newest candle (TradingView right margin) */
  private futureBars = DEFAULT_FUTURE_BARS;
  private crosshair: { x: number | null; y: number | null } = { x: null, y: null };
  private dragStartX: number | null = null;
  private dragStartScroll = 0;
  // drawing layer state (ToolId "cross" = pass-through to pan/zoom)
  private drawTool: ToolId = "cross";
  private strokeColor = "#2962ff";
  private strokeWidth = 2;
  private shapes: Shape[] = [];
  private pending: Anchor[] = [];
  private brushPts: Anchor[] | null = null;
  private brushLastPx: { x: number; y: number } | null = null;
  private geom: { left: number; right: number; top: number; priceBot: number; priceH: number; lo: number; hi: number; slice: Candle[]; plotLen: number } | null = null;
  private resizeObs?: ResizeObserver;
  private rafScheduled = false;
  private wsHandle?: { close: () => void } | null;
  private yahooPollTimer: number | null = null; // id returned by setInterval
  private ibPollTimer: number | null = null;
  private ibLastSync = 0;
  /** FX live mode (Yahoo-sourced FX history can never give real OHLC today):
   *  real candles aggregated client-side from the IB 1-minute bars (gateway
   *  computes OHLC from live ticks). Real bars cover only the time this pane
   *  has been open; flat Yahoo dashes show under them. Persisted per
   *  symbol+timeframe in localStorage. */
  private fxLiveOnly = false;
  private fxBuckets: Map<number, Candle> = new Map();
  private fxSeenV: Map<number, number> = new Map();
  private flatBase: Candle[] | null = null;
  private countdownTimer: number | null = null;
  private countdownEl!: HTMLElement;
  private priceZoom = 1;
  private priceOffset = 0;           // vertical pan offset (in price units)
  private priceDrag: { startY: number; startZoom: number } | null = null;
  private pricePanDrag: { startY: number; startOffset: number } | null = null;
  /** when true, plain left-drag pans vertically instead of horizontally */
  private pricePanMode = false;
  /** drag of an existing drawing (currently: long/short position box parts) */
  private shapeDrag: {
    kind: "move" | "entry" | "stop" | "target" | "extend";
    id: string;
    startX: number;           // canvas-relative px at drag start
    orig: Anchor[];           // anchors as they were at drag start
  } | null = null;
  private lastError: string | null = null;
  private cb: PaneCallbacks;

  constructor(id: number, symbol: string, timeframe: Timeframe, cb: PaneCallbacks) {
    this.id = id; this.symbol = symbol; this.timeframe = timeframe; this.cb = cb;
    this.shapes = listShapes(symbol, timeframe);
    this.buildDom();
    this.requestFitAndDraw();
    this.countdownTimer = window.setInterval(() => this.updateCountdown(), 1000);
  }

  // ─── DOM construction ───────────────────────────────────────────────
  private buildDom(): void {
    this.wrap = document.createElement("div");
    this.wrap.className = "pane";
    this.wrap.dataset.paneId = String(this.id);

    this.headerEl = document.createElement("div");
    this.headerEl.className = "pane-header";

    const sym = document.createElement("span");
    sym.className = "symbol";
    sym.textContent = this.symbol;
    this.symbolEl = sym;

    this.tfSelect = document.createElement("select");
    this.tfSelect.title = "timeframe";
    for (const t of ["1m", "5m", "15m", "30m", "1h", "4h", "1D", "1W", "1M"]) {
      const opt = new Option(t, t);
      if (t === this.timeframe) opt.selected = true;
      this.tfSelect.append(opt);
    }
    this.tfSelect.addEventListener("change", () => {
      this.timeframe = this.tfSelect.value as Timeframe;
      this.shapes = listShapes(this.symbol, this.timeframe);
      this.pending = []; this.brushPts = null;
      void this.load();
      // keep the fullscreen badge in sync when the timeframe changes
      this.updateFsBadge();
    });

    const oscBtn = document.createElement("button");
    oscBtn.textContent = "OSC";
    oscBtn.title = "cycle oscillator RSI → MACD → off";
    oscBtn.addEventListener("click", () => this.toggleOscillator());

    this.priceEl = document.createElement("span");
    this.priceEl.className = "price";
    this.priceEl.textContent = "—";

    this.countdownEl = document.createElement("span");
    this.countdownEl.className = "countdown";
    this.countdownEl.title = "time until this candle closes";
    this.countdownEl.textContent = "—";

    const expand = document.createElement("button");
    expand.textContent = "⤢";
    expand.title = "fullscreen this pane (Esc or ⤡ to exit)";
    expand.className = "expand-btn";
    expand.addEventListener("click", () => this.toggleFullscreen());
    this.expandBtn = expand as HTMLButtonElement;

    const rm = document.createElement("button");
    rm.textContent = "×";
    rm.title = "remove pane";
    rm.addEventListener("click", () => this.remove());

    this.headerEl.append(sym, this.tfSelect, oscBtn, this.priceEl, this.countdownEl, expand, rm);
    this.wrap.append(this.headerEl);

    this.canvas = document.createElement("canvas");
    this.canvas.className = "panes-canvas";
    this.wrap.append(this.canvas);
    this.ctx = this.canvas.getContext("2d")!;

    // horizontal history slider — only shown in fullscreen (CSS)
    this.hscrollEl = document.createElement("div");
    this.hscrollEl.className = "pane-hscroll";
    this.hscrollInput = document.createElement("input");
    this.hscrollInput.type = "range";
    this.hscrollInput.className = "pane-hscroll-range";
    this.hscrollInput.min = "0";
    this.hscrollInput.step = "1";
    this.hscrollInput.value = "0";
    this.hscrollInput.title = "drag left for older bars · drag right for newer bars";
    this.hscrollInput.setAttribute("aria-label", "scroll chart history");
    this.hscrollInput.addEventListener("input", () => this.onHscrollInput());
    this.hscrollEl.append(this.hscrollInput);
    this.wrap.append(this.hscrollEl);

    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    this.canvas.addEventListener("pointermove", this.onPointerMove);
    this.canvas.addEventListener("pointerup", this.onPointerUp);
    this.canvas.addEventListener("pointercancel", this.onPointerUp);
    this.canvas.addEventListener("pointerleave", this.onPointerLeave);
    this.canvas.addEventListener("dblclick", this.onDoubleClick);
    this.canvas.addEventListener("contextmenu", (e) => {
      if (this.drawTool !== "cross" || (this.pending.length || this.brushPts) || this.overPriceAxis(e.clientX)) e.preventDefault();
    });

    this.resizeObs = new ResizeObserver(() => this.requestFitAndDraw());
    this.resizeObs.observe(this.wrap);
  }

  // ─── lifecycle ─────────────────────────────────────────────────────
  private requestFitAndDraw(): void {
    if (this.rafScheduled) return;
    this.rafScheduled = true;
    requestAnimationFrame(() => {
      this.rafScheduled = false;
      this.fitCanvas();
      this.draw();
    });
  }

  /** CSS box of the canvas (already excludes the header and, in fullscreen, the slider row) */
  private canvasBox(): { w: number; h: number } {
    const r = this.canvas.getBoundingClientRect();
    return { w: Math.max(200, Math.round(r.width)), h: Math.max(140, Math.round(r.height)) };
  }

  private fitCanvas(): void {
    const dpr = window.devicePixelRatio || 1;
    const { w, h } = this.canvasBox();
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  async load(): Promise<void> {
    this.cb.onStatus(`Loading ${this.symbol} ${this.timeframe}…`);
    try {
      const r = await loadHistory(this.symbol, this.timeframe);
      this.candles = r.candles;
      this.fxLiveOnly = false;
      this.flatBase = null;
      this.fxBuckets.clear();
      this.fxSeenV.clear();
      this.lastError = null;
      this.indicator = this.candles.length >= 30 ? computeAll(this.candles) : null;
      this.offsetBars = 0;
      this.futureBars = DEFAULT_FUTURE_BARS;
      this.priceOffset = 0;
      const histLast = this.candles[this.candles.length - 1];
      if (histLast) checkPrice(this.symbol, histLast.c);
      this.closeLiveFeed();
      this.stopIbPoll();
      this.ibLastSync = 0;
      if (r.source === "binance") {
        this.stopYahooPoll();
        this.startLiveFeed();
      } else if (r.source === "ib") {
        this.stopYahooPoll();
        this.startIbPoll();
      } else {
        this.stopYahooPoll();
        const fxNow = /^[A-Za-z]{6}=X$/.test(this.symbol);
        if (fxNow && ["1m", "5m", "15m", "30m", "1h"].includes(this.timeframe)) {
          this.enterFxLiveMode();
        } else {
          this.startYahooPoll();
        }
      }
      this.draw();
    } catch (err) {
      this.lastError = (err as Error).message.slice(0, 160);
      this.cb.onStatus(`ERR ${this.symbol}: ${this.lastError}`);
      this.requestFitAndDraw();
    }
  }

  private startLiveFeed(): void {
    this.closeLiveFeed();
    try {
      this.wsHandle = openBinanceKlineStream(this.symbol, this.timeframe, (b) => {
        const last = this.candles[this.candles.length - 1];
        const bar: Candle = { t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v };
        if (last && Math.floor(last.t / 1000) === Math.floor(bar.t / 1000)) {
          this.candles[this.candles.length - 1] = bar;
        } else {
          this.candles.push(bar);
          if (this.candles.length > 2000) this.candles.shift();
        }
        if (this.candles.length >= 30) this.indicator = computeAll(this.candles);
        checkPrice(this.symbol, bar.c);
        this.draw();
        this.cb.onStatus(`LIVE ${this.symbol} ${this.timeframe}${b.closed ? " · closed bar" : ""}`);
      });
    } catch {
      /* WS unavailable — stay on history data */
    }
  }

  private closeLiveFeed(): void {
    if (this.wsHandle) {
      try { this.wsHandle.close(); } catch { /* noop */ }
      this.wsHandle = null;
    }
  }

  // ─── Yahoo polling (snapshot data, refreshed on an interval) ───────
  private startYahooPoll(): void {
    this.stopYahooPoll();
    this.yahooPollTimer = window.setInterval(() => { void this.pollYahoo(); }, YAHOO_POLL_MS);
  }

  private stopYahooPoll(): void {
    if (this.yahooPollTimer !== null) {
      window.clearInterval(this.yahooPollTimer);
      this.yahooPollTimer = null;
    }
  }

  // ─── IB polling (live 1m bar aggregated from gateway ticks) ─────────
  private startIbPoll(): void {
    this.stopIbPoll();
    this.ibPollTimer = window.setInterval(() => { void this.pollIb(); }, 1000);
  }

  private stopIbPoll(): void {
    if (this.ibPollTimer !== null) {
      window.clearInterval(this.ibPollTimer);
      this.ibPollTimer = null;
    }
  }

  private mergeCandles(fresh: Candle[]): void {
    if (fresh.length === 0) return;
    const byT = new Map<number, Candle>();
    for (const c of this.candles) byT.set(c.t, c);
    for (const c of fresh) byT.set(c.t, c);
    const merged = [...byT.values()].sort((a, b) => a.t - b.t);
    this.candles = merged.length > MAX_BARS ? merged.slice(-MAX_BARS) : merged;
  }

  private async pollIb(): Promise<void> {
    try {
      // periodic full resync so closed bars and gaps are corrected
      if (!this.fxLiveOnly && Date.now() - this.ibLastSync > 30_000) {
        this.ibLastSync = Date.now();
        try {
          const full = await loadIbHistory(this.symbol, this.timeframe);
          this.mergeCandles(full);
        } catch { /* keep current bars */ }
      }
      const bars = await loadIbCandles(this.symbol);
      if (bars.length === 0) return;
      if (this.fxLiveOnly) {
        this.updateFxBuckets(bars);
      } else {
        this.mergeCandles(bars);
      }
      this.lastError = null;
      if (this.candles.length >= 30) this.indicator = computeAll(this.candles);
      const last = bars[bars.length - 1];
      checkPrice(this.symbol, last.c);
      this.draw();
      const liveLabel = this.fxLiveOnly ? "LIVE ticks → real candles" : "LIVE";
      this.cb.onStatus(`IB ${this.symbol} ${this.timeframe} · ${liveLabel} · ${new Date(last.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}`);
    } catch (err) {
      this.cb.onStatus(`IB ${this.symbol} poll failed — is TWS/IB Gateway running? ${(err as Error).message.slice(0, 90)}`);
    }
  }

  private async pollYahoo(): Promise<void> {
    try {
      const fresh = await loadYahooRefresh(this.symbol, this.timeframe);
      if (fresh.length === 0) {
        console.warn(`[pane ${this.symbol} ${this.timeframe}] empty poll response — keeping ${this.candles.length} existing bars`);
        return;
      }
      const intraday = ["1m", "5m", "15m", "30m", "1h", "4h"].includes(this.timeframe);
      if (intraday && this.candles.length > 0) {
        // merge polled bars into existing history by timestamp
        const byT = new Map<number, Candle>();
        for (const c of this.candles) byT.set(c.t, c);
        for (const c of fresh) byT.set(c.t, c);
        const merged = [...byT.values()].sort((a, b) => a.t - b.t);
        this.candles = merged.length > MAX_BARS ? merged.slice(-MAX_BARS) : merged;
      } else {
        this.candles = fresh;
      }
      this.lastError = null;
      if (this.candles.length >= 30) this.indicator = computeAll(this.candles);
      const pollLast = this.candles[this.candles.length - 1];
      if (pollLast) checkPrice(this.symbol, pollLast.c);
      // keep the user's visible offset but redraw everything incl. price axis
      this.draw();
      const last = this.candles[this.candles.length - 1];
      if (last) this.cb.onStatus(`Yahoo ${this.symbol} ${this.timeframe} · last ${new Date(last.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })} · 5s refresh`);
    } catch (err) {
      console.warn(`[pane ${this.symbol} ${this.timeframe}] poll failed: ${(err as Error).message}`);
    }
  }

  /** FX intraday panes with no IB historical data permission: keep the Yahoo
   *  last-price flats as a neutral dashed baseline and build REAL candles from
   *  the IB 1-minute bars that the gateway computes from live ticks. Real
   *  bars replace the covering flats by timestamp; everything is honest
   *  OHLC (no invented ranges). */
  private enterFxLiveMode(): void {
    this.fxLiveOnly = true;
    this.flatBase = this.candles.slice();
    this.restoreFxLive();
    this.rebuildFxCandles();
    this.startIbPoll();
    this.cb.onStatus(
      `${this.symbol} ${this.timeframe} · FX candles from IB live ticks · pre-session = Yahoo last-price reconstructed shape (not real range) · real candles build from this session`
    );
  }

  private fxLiveKey(): string { return `fxlive:${this.symbol}:${this.timeframe}`; }

  private restoreFxLive(): void {
    this.fxBuckets.clear();
    this.fxSeenV.clear();
    try {
      const raw = window.localStorage.getItem(this.fxLiveKey());
      if (!raw) return;
      const parsed = JSON.parse(raw) as { buckets?: [number, Candle][]; seen?: [number, number][] } | null;
      const cutoff = Date.now() - 72 * 3600_000;
      if (parsed?.buckets) {
        for (const [t, b] of parsed.buckets) {
          if (Number(t) >= cutoff && b && typeof b.o === "number" && typeof b.c === "number") {
            this.fxBuckets.set(Number(t), b);
          }
        }
      }
      if (parsed?.seen) {
        for (const [t, v] of parsed.seen) {
          if (Date.now() - Number(t) < 5 * 60_000) this.fxSeenV.set(Number(t), Number(v));
        }
      }
    } catch { /* storage unavailable — start empty */ }
  }

  private saveFxLive(): void {
    try {
      const buckets = [...this.fxBuckets.entries()].slice(-4000);
      const seen = [...this.fxSeenV.entries()].slice(-8);
      window.localStorage.setItem(this.fxLiveKey(), JSON.stringify({ buckets, seen }));
    } catch { /* storage unavailable — ignore */ }
  }

  private updateFxBuckets(bars: Candle[]): void {
    const tfMs = TF_MS[this.timeframe] ?? 60_000;
    for (const c of bars) {
      if (![c.o, c.h, c.l, c.c].every(Number.isFinite)) continue;
      const bT = Math.floor(c.t / tfMs) * tfMs;
      const seen = this.fxSeenV.get(c.t) ?? 0;
      const deltaV = Math.max(0, (Number(c.v) || 0) - seen);
      this.fxSeenV.set(c.t, Math.max(0, Number(c.v) || 0));
      const b = this.fxBuckets.get(bT);
      if (!b) {
        this.fxBuckets.set(bT, { t: bT, o: c.o, h: c.h, l: c.l, c: c.c, v: deltaV });
      } else {
        if (c.h > b.h) b.h = c.h;
        if (c.l < b.l) b.l = c.l;
        b.c = c.c;
        b.v = Math.max(0, b.v) + deltaV;
      }
    }
    const cutoff = Date.now() - 72 * 3600_000;
    for (const k of this.fxBuckets.keys()) if (k < cutoff) this.fxBuckets.delete(k);
    this.rebuildFxCandles();
    this.saveFxLive();
  }

  /** Cheap rebuild of the candle array: Yahoo baseline minus bars covered by
   *  real live buckets, plus the live buckets themselves sorted by time. */
  private rebuildFxCandles(): void {
    const tfMs = TF_MS[this.timeframe] ?? 60_000;
    const real = [...this.fxBuckets.values()];
    const covered = new Set<number>();
    for (const b of real) for (let t = b.t; t < b.t + tfMs; t += 60_000) covered.add(t);
    const base = (this.flatBase ?? []).filter((b) => !covered.has(b.t));
    this.candles = [...base, ...real].sort((a, b) => a.t - b.t);
    if (this.candles.length > MAX_BARS) this.candles = this.candles.slice(-MAX_BARS);
  }

  toggleFullscreen(): void {
    this.fullscreen = !this.fullscreen;
    this.wrap.classList.toggle("fullscreen", this.fullscreen);
    this.expandBtn.textContent = this.fullscreen ? "⤡" : "⤢";
    this.expandBtn.title = this.fullscreen ? "exit fullscreen (Esc)" : "fullscreen this pane (Esc / ⤡)";
    this.cb.onStatus(this.fullscreen ? `⛶ ${this.symbol} — Esc or ⤡ to exit fullscreen` : "Back in grid view");
    this.updateFsBadge();
    // element resized via CSS → ResizeObserver fires and refits canvas;
    // the explicit refit also reserves/unreserves the slider row immediately
    this.requestFitAndDraw();
  }

  // ─── fullscreen history slider ─────────────────────────────────────
  /** Keep the slider in sync: 0 = oldest history (left), max = newest (right). */
  private syncHscroll(): void {
    if (!this.hscrollInput) return;
    const total = this.candles.length;
    const n = Math.min(this.visibleBars, total);
    const maxOffset = Math.max(0, total - n);
    this.offsetBars = Math.max(0, Math.min(maxOffset, this.offsetBars));
    this.hscrollInput.max = String(maxOffset);
    this.hscrollInput.value = String(maxOffset - this.offsetBars);
    this.hscrollInput.disabled = maxOffset <= 0;
  }

  private onHscrollInput(): void {
    const total = this.candles.length;
    const n = Math.min(this.visibleBars, total);
    const maxOffset = Math.max(0, total - n);
    const v = Math.max(0, Math.min(maxOffset, Math.round(Number(this.hscrollInput.value) || 0)));
    // the slider counts from the oldest bar: dragging right → newer bars
    this.offsetBars = maxOffset - v;
    this.futureBars = 0;
    this.draw();
  }

  /** Refresh the fullscreen badge (symbol + timeframe) — call after the
     *  symbol or timeframe changes so the overlay never shows stale text. */
  refreshFsBadge(): void { this.updateFsBadge(); }
  private updateFsBadge(): void {
    if (this.fullscreen) {
      if (!this.fsBadge) {
        this.fsBadge = document.createElement("div");
        this.fsBadge.className = "fs-badge";
        this.fsBadge.setAttribute("aria-hidden", "true");
        document.body.append(this.fsBadge);
      }
      this.fsBadge.textContent = `${this.symbol}  ${this.timeframe}`;
      this.fsBadge.style.display = "block";
    } else if (this.fsBadge) {
      this.fsBadge.remove();
      this.fsBadge = null;
    }
  }

  toggleOscillator(): void {
    const order: OscillatorMode[] = ["rsi", "macd", "off"];
    this.oscMode = order[(order.indexOf(this.oscMode) + 1) % order.length];
    this.draw();
  }

  // ─── rendering ─────────────────────────────────────────────────────
  private visibleSlice(): { slice: Candle[]; offset: number } {
    const total = this.candles.length;
    const n = Math.min(this.visibleBars, total);
    const maxOffset = Math.max(0, total - n);
    this.offsetBars = Math.max(0, Math.min(maxOffset, this.offsetBars));
    return { slice: this.candles.slice(total - this.offsetBars - n, total - this.offsetBars), offset: total - this.offsetBars - n };
  }

  private draw(): void {
    const ctx = this.ctx;
    const P = palette();
    this.syncHscroll();
    const { w: W, h: H } = this.canvasBox();
    ctx.fillStyle = P.panel;
    ctx.fillRect(0, 0, W, H);
    const paintNoData = (msg: string): void => {
      ctx.fillStyle = P.dimText;
      ctx.font = "12px -apple-system,'Segoe UI',Roboto,sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(msg, W / 2, H / 2);
    };
    if (this.candles.length === 0) {
      paintNoData(this.lastError ? `ERR ${this.lastError}` : `No candles for ${this.symbol} ${this.timeframe} — fetching…`);
      return;
    }
    const { slice, offset } = this.visibleSlice();
    if (slice.length === 0) {
      paintNoData("No visible bars — fetch more history or check the symbol");
      return;
    }

    let lo = Infinity, hi = -Infinity;
    for (const c of slice) { if (c.l < lo) lo = c.l; if (c.h > hi) hi = c.h; }
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo === hi) { lo = 0; hi = 1; }
    const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
    // vertical (price scale) zoom, driven by right-drag / wheel on the price axis
    if (this.priceZoom !== 1) {
      const mid = (lo + hi) / 2;
      const half = ((hi - lo) / 2) / this.priceZoom;
      lo = mid - half;
      hi = mid + half;
    }
    // vertical pan — drag the whole price scale up/down
    if (this.priceOffset !== 0) { lo -= this.priceOffset; hi -= this.priceOffset; }

    const left = 4, right = W - PRICE_AXIS_W - 2;
    const top = 16, bottom = 22;
    // spot FX has no consolidated volume: either hide the strip or show the
    // tick counts the IB bridge accumulates for the current bars
    const isFxSymbol = /^[A-Z]{6}=X$/.test(this.symbol.toUpperCase());
    const volBars = slice.filter((c) => Number.isFinite(c.v) && c.v > 0).length;
    // FX tick volume is backfilled for the recent ~2 hours only, so require most
    // of the visible bars to have counts before drawing a partial strip.
    const showVolume = isFxSymbol
      ? volBars >= Math.ceil(slice.length * 0.5)
      : volBars >= Math.max(2, Math.floor(slice.length * 0.15));
    const volH = showVolume ? Math.max(34, Math.round(H * 0.17)) : 0;
    const oscH = this.oscMode === "off" ? 0 : Math.max(46, Math.round(H * 0.22));
    const priceBot = H - bottom - volH - (oscH ? oscH + 6 : 0) - 6 - (volH ? 6 : 0);
    const priceH = Math.max(40, priceBot - top);
    const yOf = (v: number) => top + ((hi - v) / (hi - lo)) * priceH;
    // futureBars keeps empty room right of the newest candle so its wick/body is
    // never clipped by the price axis, and lets you scroll into the future.
    const plotLen = Math.max(1, slice.length + this.futureBars);
    const step = Math.max(2, (right - left) / plotLen);
    const xOf = (i: number) => left + ((i + 0.5) / plotLen) * (right - left);
    this.geom = { left, right, top, priceBot, priceH, lo, hi, slice, plotLen };

    // gridlines + price axis
    ctx.strokeStyle = P.grid;
    ctx.fillStyle = P.axisText;
    ctx.font = FONT_DIM;
    ctx.textBaseline = "middle";
    ctx.textAlign = "right";
    // Draw 4 interior gridlines + labels (skip top/bottom edges to avoid clipping)
    for (let i = 1; i <= 4; i++) {
      const v = lo + (hi - lo) * (i / 5);
      const y = yOf(v);
      ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke();
      ctx.fillText(fmtPrice(v), right - 10, y);
    }
    // Top label (slightly below top edge)
    ctx.fillText(fmtPrice(hi), right - 10, top + 10);
    // Bottom label (slightly above price bottom edge)
    ctx.fillText(fmtPrice(lo), right - 10, priceBot - 10);

    // candles
    const bodyW = Math.max(2, step * 0.72);
    for (let i = 0; i < slice.length; i++) {
      const c = slice[i];
      // zero-range bars (spot FX has no traded range on Yahoo last-price data):
      // draw a muted full-width dash instead of a green "dot"
      const flat = c.o === c.h && c.h === c.l && c.l === c.c;
      if (flat) {
        ctx.save();
        ctx.globalAlpha = 0.55;
        ctx.strokeStyle = P.dimText;
        ctx.lineWidth = 2;
        ctx.beginPath();
        const y = yOf(c.l);
        ctx.moveTo(xOf(i) - bodyW / 2, y);
        ctx.lineTo(xOf(i) + bodyW / 2, y);
        ctx.stroke();
        ctx.restore();
        continue;
      }
      const up = c.c >= c.o;
      const col = up ? P.up : P.down;
      ctx.strokeStyle = col;
      ctx.lineWidth = Math.max(1, Math.floor(step * 0.12) || 1);
      ctx.beginPath(); ctx.moveTo(xOf(i), yOf(c.h)); ctx.lineTo(xOf(i), yOf(c.l)); ctx.stroke();
      ctx.fillStyle = up ? P.upFill : P.downFill;
      const yTop = yOf(Math.max(c.o, c.c));
      const yBot = yOf(Math.min(c.o, c.c));
      ctx.fillRect(xOf(i) - bodyW / 2, yTop, bodyW, Math.max(1, yBot - yTop));
    }

    // indicator overlays
    if (this.indicator) {
      polyline(ctx, this.indicator.sma10, offset, slice, plotLen, yOf, P.sma10, left, right, 1.4);
      polyline(ctx, this.indicator.sma30, offset, slice, plotLen, yOf, P.sma30, left, right, 1.4);
      polyline(ctx, this.indicator.ema12, offset, slice, plotLen, yOf, P.ema12, left, right, 1.2);
    }

    // TradingView-style last-price line — tracks the live close across the pane.
    // Every live update path calls draw() (Binance WS, IB poll, Yahoo poll), so
    // the line moves in real time with no extra wiring.
    const lastCandle = this.candles[this.candles.length - 1];
    if (lastCandle && Number.isFinite(lastCandle.c)) {
      const lp = lastCandle.c;
      const liveCol = lastCandle.c >= lastCandle.o ? P.up : P.down;
      if (lp >= lo && lp <= hi) {
        const y = yOf(lp);
        ctx.save();
        ctx.globalAlpha = 0.9;
        ctx.strokeStyle = liveCol;
        ctx.lineWidth = 1;
        ctx.setLineDash([5, 4]);
        ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      }
      // price tag on the scale axis, clamped to the visible range (TradingView
      // keeps the tag at the edge when the price scrolls out of view)
      const tagY = Math.min(Math.max(yOf(lp), top + 8), priceBot - 8);
      ctx.fillStyle = liveCol;
      ctx.fillRect(right, tagY - 8, PRICE_AXIS_W - 2, 16);
      ctx.fillStyle = "#ffffff";
      ctx.font = FONT_DIM;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(fmtPrice(lp), right + 4, tagY);
    }

    // volume strip — hidden when the feed has no volume (spot FX) so no fake
    // or negative-height bars can be drawn
    const volTop = priceBot + 6;
    if (showVolume) {
      let vMax = 0;
      for (const c of slice) { const v = Number.isFinite(c.v) ? c.v : 0; if (v > vMax) vMax = v; }
      const volHPx = Math.max(28, volH - 2);
      for (let i = 0; i < slice.length; i++) {
        const c = slice[i];
        const v = Number.isFinite(c.v) ? Math.max(0, c.v) : 0;
        const h = vMax > 0 ? Math.min(1, v / vMax) * volHPx : 0;
        if (h <= 0) continue;
        ctx.fillStyle = c.c >= c.o ? P.volUp : P.volDown;
        ctx.fillRect(xOf(i) - (step - 2) / 2, volTop + volHPx - h, Math.max(1, step - 2), h);
      }
      if (volTop - 9 > 10) {
        ctx.fillStyle = P.mutedText; ctx.font = FONT_DIM;
        ctx.textAlign = "left"; ctx.textBaseline = "top";
        const fxLabel = /^[A-Z]{6}=X$/.test(this.symbol.toUpperCase());
        ctx.fillText(fxLabel ? "TICK VOL" : "VOL", left + 4, volTop - 9);
      }
    }

    // oscillator strip (RSI / MACD)
    const oscTop = volTop + (showVolume ? volH + 6 : 0);
    if (this.oscMode !== "off" && this.indicator) {
      const series = this.oscMode === "rsi" ? this.indicator.rsi : this.indicator.macd.hist;
      let lo2 = -Infinity, hi2 = Infinity;
      for (const v of series) { if (v == null) continue; if (v < lo2) lo2 = v; if (v > hi2) hi2 = v; }
      if (!Number.isFinite(lo2) || !Number.isFinite(hi2) || hi2 - lo2 < 1) { lo2 = 30; hi2 = 70; }
      if (this.oscMode === "rsi") { lo2 = Math.min(lo2, 30); hi2 = Math.max(hi2, 70); }
      else { const m = Math.max(Math.abs(lo2), Math.abs(hi2)) || 1; lo2 = -m; hi2 = m; }
      const yTop = oscTop + 4, yBot = oscTop + oscH - 4;
      const j = (v: number) => yBot - ((v - lo2) / (hi2 - lo2)) * (yBot - yTop);

      ctx.strokeStyle = P.grid;
      ctx.beginPath();
      ctx.moveTo(left, yTop); ctx.lineTo(right, yTop);
      ctx.moveTo(left, oscTop + oscH / 2); ctx.lineTo(right, oscTop + oscH / 2);
      ctx.moveTo(left, yBot); ctx.lineTo(right, yBot);
      ctx.stroke();

      if (this.oscMode === "rsi") {
        ctx.setLineDash([4, 4]); ctx.strokeStyle = P.oscGuide;
        for (const lv of [70, 30]) {
          const y = j(lv); ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke();
        }
        ctx.setLineDash([]);
        polyline(ctx, series, offset, slice, plotLen, j, P.rsi, left, right, 1.6);
        ctx.fillStyle = P.dimText;
        ctx.textAlign = "left"; ctx.fillText("RSI 14", left + 4, yTop + 4);
        ctx.textAlign = "right";
        ctx.fillText(String(Math.round(series[series.length - 1] ?? 0)), right - 4, yTop + 4);
      } else {
        for (let i = 0; i < slice.length; i++) {
          const v = series[offset + i];
          if (v == null) continue;
          const y = j(v), yZero = j(0);
          ctx.fillStyle = v >= 0 ? P.macdHistUp : P.macdHistDown;
          ctx.fillRect(xOf(i) - (step - 2) / 2, Math.min(y, yZero), Math.max(1, step - 2), Math.max(1, Math.abs(y - yZero)));
        }
        polyline(ctx, this.indicator.macd.signal, offset, slice, plotLen, j, P.macdSignal, left, right, 1.2);
        polyline(ctx, this.indicator.macd.macd, offset, slice, plotLen, j, P.macd, left, right, 1.2);
        ctx.fillStyle = P.dimText;
        ctx.textAlign = "left"; ctx.fillText("MACD", left + 4, yTop + 4);
      }
    }

    // drawings — anchored to time/price so they survive pan/zoom/timeframe
    ctx.save();
    ctx.beginPath();
    ctx.rect(left, top, Math.max(0, right - left), Math.max(0, priceBot - top));
    ctx.clip();
    const dctx = this.buildDrawCtx(ctx, this.geom);
    for (const s of this.shapes) drawShape(s, dctx);

    // preview of the in-progress drawing
    const previewPts: Anchor[] | null =
      this.brushPts && this.brushPts.length > 1 ? this.brushPts
        : this.pending.length > 0 && this.crosshair.x !== null && this.crosshair.y !== null
          ? [...this.pending, { t: this.timeAtX(this.crosshair.x) ?? 0, p: this.priceAtY(this.crosshair.y) }]
          : null;
    if (previewPts && previewPts.length > 1) {
      drawShape(
        {
          id: "__preview",
          kind: this.drawTool,
          a: previewPts[0],
          b: previewPts[1],
          pts: previewPts,
          color: this.strokeColor,
          width: this.strokeWidth,
        },
        dctx,
      );
    }

    // price-alert levels for this symbol
    for (const alert of listAlerts()) {
      if (alert.symbol !== this.symbol.toUpperCase()) continue;
      const y = dctx.priceToY(alert.price);
      if (y < top || y > priceBot) continue;
      ctx.strokeStyle = P.alert;
      ctx.lineWidth = 1;
      ctx.setLineDash([5, 4]);
      ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = "10px sans-serif";
      ctx.textAlign = "right"; ctx.textBaseline = "bottom";
      ctx.fillStyle = P.alert;
      ctx.fillText(`🔔 ${fmtPrice(alert.price)}`, right - 4, y - 2);
    }
    ctx.restore();

    // time axis
    ctx.fillStyle = P.axisTextDim;
    ctx.font = FONT_DIM;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const timeStep = Math.max(1, Math.floor(slice.length / 6));
    for (let i = 0; i < slice.length; i += timeStep) {
      ctx.fillText(fmtTime(slice[i].t, this.timeframe), xOf(i), H - 11);
    }

    // open/close + candle-close countdown pill — pinned to the right end of
    // the time-axis row so it stays visible in fullscreen (the pane-header
    // chip isn't enough there). TradingView-style.
    {
      const b = this.candleCountdown();
      if (b) {
        const remain = b.remain;
        const line = `O ${fmtClock(b.o)} · C ${fmtClock(b.c)} · ⏳ ${fmtCountdown(Math.ceil(remain / 1000))}`;
        ctx.save();
        ctx.font = FONT_DIM;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        const w = ctx.measureText(line).width + 16;
        const y = H - 11;
        ctx.fillStyle = "rgba(16,22,28,0.9)";
        ctx.fillRect(right - w, y - 9, w, 18);
        ctx.fillStyle = remain <= 0 ? P.up : "#ffffff";
        ctx.fillText(line, right - w + 8, y);
        ctx.restore();
      }
    }

    // crosshair
    if (this.crosshair.x !== null) {
      const { x, y } = this.crosshair;
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = P.crosshair;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H - bottom); ctx.stroke();
      if (y !== null) { ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke(); }
      ctx.setLineDash([]);
      const stepX = Math.max(1, (right - left) / plotLen);
      const rawIdx = Math.floor((x - left) / stepX);
      const hc = rawIdx >= 0 && rawIdx < slice.length ? slice[rawIdx] : null;
      if (hc) {
        const label = `O ${hc.o.toFixed(2)}  H ${hc.h.toFixed(2)}  L ${hc.l.toFixed(2)}  C ${hc.c.toFixed(2)}`;
        ctx.font = FONT_DIM;
        ctx.textAlign = "left"; ctx.textBaseline = "top";
        const tw = ctx.measureText(label).width + 12;
        ctx.fillStyle = P.legendBg;
        ctx.fillRect(left + 2, top + 2, tw, 18);
        ctx.fillStyle = P.legendText;
        ctx.fillText(label, left + 8, top + 3);
      }
      if (y !== null && y <= priceBot) {
        const v = hi - ((y - top) / priceH) * (hi - lo);
        ctx.fillStyle = P.priceTagBg;
        ctx.fillRect(right, y - 8, PRICE_AXIS_W - 2, 16);
        ctx.fillStyle = P.legendText;
        ctx.fillText(fmtPrice(v), right + 4, y);
      }
    }

    this.updatePriceLabel();
  }

  // ─── interaction ───────────────────────────────────────────────────
  private overPriceAxis(clientX: number): boolean {
    // measure against the pane, not the canvas: after entering fullscreen the
    // canvas can still carry the pre-fullscreen size for a frame
    const rect = this.wrap.getBoundingClientRect();
    return clientX >= rect.right - PRICE_AXIS_W - 2;
  }

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    if (this.overPriceAxis(e.clientX)) {
      // wheel on the price scale zooms vertically (TradingView behaviour)
      const f = e.deltaY > 0 ? 1 / 1.12 : 1.12;
      this.priceZoom = Math.max(0.25, Math.min(20, this.priceZoom * f));
      this.requestFitAndDraw();
      return;
    }
    const factor = e.deltaY > 0 ? 1 / 1.1 : 1.1;
    this.visibleBars = Math.max(20, Math.min(600, Math.round(this.visibleBars * factor)));
    this.requestFitAndDraw();
  };

  private onPointerDown = (e: PointerEvent): void => {
    // price-scale zoom: drag with left OR right button, in grid or fullscreen
    if ((e.button === 0 || e.button === 2) && this.overPriceAxis(e.clientX)) {
      this.priceDrag = { startY: e.clientY, startZoom: this.priceZoom };
      try { this.canvas.setPointerCapture(e.pointerId); } catch { /* noop */ }
      e.preventDefault();
      return;
    }
    if (e.button === 2) {
      if (this.pending.length || this.brushPts) { this.pending = []; this.brushPts = null; this.brushLastPx = null; this.requestFitAndDraw(); e.preventDefault(); }
      return;
    }
    if (e.button !== 0) return;
    if (this.drawTool !== "cross") {
      e.preventDefault();
      this.handleToolPointerDown(e);
      return;
    }
    // grabbing an existing long/short position drawing wins over chart panning —
    // drag the SL/TP/entry boundaries vertically or the whole box side-to-side
    const picked = this.pickPositionShape(e);
    if (picked) {
      this.shapeDrag = picked;
      try { this.canvas.setPointerCapture(e.pointerId); } catch { /* noop */ }
      e.preventDefault();
      return;
    }
    // left-drag on the chart body:
    //   ↕ Pan mode ON  → vertical pan (drag the chart up/down)
    //   shift held     → horizontal scroll (drag left/right), regardless of mode
    //   ↕ Pan mode OFF → horizontal scroll (original behaviour)
    if (this.pricePanMode && !e.shiftKey) {
      this.pricePanDrag = { startY: e.clientY, startOffset: this.priceOffset };
      try { this.canvas.setPointerCapture(e.pointerId); } catch { /* noop */ }
      return;
    }
    this.dragStartX = e.clientX;
    this.dragStartScroll = this.offsetBars - this.futureBars;
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* noop */ }
  };

  /** Hit-test an existing long/short position box under the pointer.
   *  Returns which part grabs the drag — all y's are canvas-relative pixels. */
  private pickPositionShape(e: PointerEvent): {
    kind: "move" | "entry" | "stop" | "target" | "extend";
    id: string;
    startX: number;
    orig: Anchor[];
  } | null {
    const g = this.geom;
    if (!g) return null;
    const d = this.buildDrawCtx(this.ctx, g);
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const TOL = 6;
    for (let i = this.shapes.length - 1; i >= 0; i--) {
      const s = this.shapes[i];
      if (s.kind !== "position") continue;
      const pts = s.pts;
      if (!pts || pts.length < 3) continue;
      const px = pts.map((a) => ({ x: d.timeToX(a.t), y: d.priceToY(a.p) }));
      const entry = px[0], stop = px[1], target = px[2];
      const x1 = Math.min(entry.x, stop.x, target.x);
      const right = pts.length >= 4 ? px[3].x : d.right;
      const yTop = Math.min(entry.y, stop.y, target.y);
      const yBot = Math.max(entry.y, stop.y, target.y);
      const tRight = this.timeAtX(d.right) ?? pts[0].t;
      const full = pts.length >= 4 ? pts : [...pts, { t: tRight, p: pts[0].p }];
      const inSweep = x >= x1 - TOL && x <= right + TOL;
      // the right edge itself — grab to stretch the position time-wise
      if (Math.abs(x - right) <= TOL && y >= yTop - 6 && y <= yBot + 6) {
        return { kind: "extend", id: s.id, startX: x, orig: full.map((a) => ({ t: a.t, p: a.p })) };
      }
      let kind: "move" | "entry" | "stop" | "target" | null = null;
      if (Math.abs(y - stop.y) <= TOL && inSweep) kind = "stop";
      else if (Math.abs(y - target.y) <= TOL && inSweep) kind = "target";
      else if (Math.abs(y - entry.y) <= TOL && inSweep) kind = "entry";
      else if (hitTest({ x, y }, s, d)) kind = "move";
      if (kind) return { kind, id: s.id, startX: x, orig: full.map((a) => ({ t: a.t, p: a.p })) };
    }
    return null;
  }

  private onPointerMove = (e: PointerEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    this.crosshair = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    if (this.brushPts) {
      const x = this.crosshair.x, y = this.crosshair.y;
      if (x !== null && y !== null) {
        const lastPx = this.brushLastPx;
        if (!lastPx || Math.hypot(x - lastPx.x, y - lastPx.y) > 3) {
          const t = this.timeAtX(x);
          if (t !== null) {
            this.brushPts.push({ t, p: this.priceAtY(y) });
            this.brushLastPx = { x, y };
          }
        }
      }
      this.requestFitAndDraw();
      return;
    }
    if (this.shapeDrag) {
      const sd = this.shapeDrag;
      const idx = this.shapes.findIndex((s) => s.id === sd.id);
      if (idx >= 0) {
        const s = this.shapes[idx];
        const pts = s.pts ? s.pts.map((a) => ({ ...a })) : [{ ...s.a }];
        if (sd.kind === "move") {
          const t0 = this.timeAtX(sd.startX);
          const t1 = this.crosshair.x !== null ? this.timeAtX(this.crosshair.x) : t0;
          if (t0 !== null && t1 !== null) {
            const dt = t1 - t0;
            s.pts = sd.orig.map((a) => ({ t: a.t + dt, p: a.p }));
            s.a = { ...s.pts[0] };
          }
        } else if (sd.kind === "extend") {
          // stretch the box's right edge across time, like TradingView's position tool
          const xNow = this.crosshair.x;
          const tNow = xNow !== null ? this.timeAtX(xNow) : null;
          const minT = Math.min(...sd.orig.map((a) => a.t));
          const next = sd.orig.map((a) => ({ ...a }));
          next[3] = { t: tNow === null ? next[3].t : Math.max(tNow, minT), p: next[3].p ?? next[0].p };
          s.pts = next;
          s.a = { ...next[0] };
        } else {
          const p = this.crosshair.y !== null ? this.priceAtY(this.crosshair.y) : pts[0].p;
          const k = sd.kind === "entry" ? 0 : sd.kind === "stop" ? 1 : 2;
          pts[k] = { t: pts[k].t, p };
          s.pts = pts;
          s.a = { ...pts[0] };
        }
      }
      this.requestFitAndDraw();
      return;
    }
    if (this.priceDrag) {
      const dy = e.clientY - this.priceDrag.startY;
      this.priceZoom = Math.max(0.25, Math.min(20, this.priceDrag.startZoom * Math.exp(-dy * 0.006)));
      this.requestFitAndDraw();
      return;
    }
    if (this.pricePanDrag) {
      const dy = e.clientY - this.pricePanDrag.startY;
      const lo = this.geom?.lo ?? 0, hi = this.geom?.hi ?? 1;
      const span = Math.max(1e-9, hi - lo);
      this.priceOffset = this.pricePanDrag.startOffset - dy * (span / this.canvas.height) * 0.5;
      this.requestFitAndDraw();
      return;
    }
    if (this.drawTool === "cross") {
      const hover = this.pickPositionShape(e);
      this.canvas.style.cursor = hover
        ? (hover.kind === "move" ? "move" : hover.kind === "extend" ? "ew-resize" : "ns-resize")
        : this.overPriceAxis(e.clientX) ? "ns-resize" : (this.pricePanMode ? "grab" : "default");
    }
    if (this.drawTool === "cross" && this.dragStartX !== null) {
      const dx = e.clientX - this.dragStartX;
      const perBar = Math.max(1, (rect.width - PRICE_AXIS_W) / (this.visibleBars + this.futureBars));
      const maxOffset = Math.max(0, this.candles.length - this.visibleBars);
      const scroll = Math.max(-MAX_FUTURE_BARS, Math.min(maxOffset, this.dragStartScroll + dx / perBar));
      this.offsetBars = Math.max(0, Math.round(scroll));
      this.futureBars = Math.max(0, -Math.round(scroll));
    }
    this.requestFitAndDraw();
  };

  private onPointerUp = (): void => {
    if (this.brushPts && this.brushPts.length > 1) {
      const pts = this.brushPts;
      this.shapes.push({ id: newShapeId(), kind: "brush", a: pts[0], pts, color: this.strokeColor, width: this.strokeWidth, createdAt: Date.now() });
      saveShapes(this.symbol, this.timeframe, this.shapes);
    }
    this.brushPts = null;
    this.brushLastPx = null;
    this.dragStartX = null;
    this.priceDrag = null;
    this.pricePanDrag = null;
    if (this.shapeDrag) {
      saveShapes(this.symbol, this.timeframe, this.shapes);
      this.shapeDrag = null;
    }
    this.requestFitAndDraw();
  };

  private onPointerLeave = (): void => {
    this.crosshair = { x: null, y: null };
    this.dragStartX = null;
    this.priceDrag = null;
    this.pricePanDrag = null;
    if (this.shapeDrag) { saveShapes(this.symbol, this.timeframe, this.shapes); this.shapeDrag = null; }
    this.requestFitAndDraw();
  };

  // ─── drawing layer ─────────────────────────────────────────────────
  private buildDrawCtx(ctx: CanvasRenderingContext2D, g: NonNullable<ChartPane["geom"]>): DrawCtx {
    const n = g.slice.length;
    const plotLen = g.plotLen;
    const left = g.left, right = g.right, top = g.top, priceH = g.priceH, lo = g.lo, hi = g.hi;
    const span = right - left;
    const msBias = n > 1 ? (g.slice[n - 1].t - g.slice[0].t) / (n - 1) : 60_000;
    const xFromI = (i: number) => left + ((i + 0.5) / plotLen) * span;
    const timeToX = (t: number): number => {
      if (n === 0) return left;
      if (t <= g.slice[0].t) return msBias > 0 ? xFromI((t - g.slice[0].t) / msBias) : left;
      const last = n - 1;
      if (t >= g.slice[last].t) return msBias > 0 ? xFromI(last + (t - g.slice[last].t) / msBias) : xFromI(last);
      let a = 0, b = n - 1;
      while (b - a > 1) { const mid = (a + b) >> 1; if (g.slice[mid].t <= t) a = mid; else b = mid; }
      const t0 = g.slice[a].t, t1 = g.slice[b].t;
      const frac = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
      return xFromI(a + frac);
    };
    const priceToY = (p: number): number => top + ((hi - p) / (hi - lo)) * priceH;
    return { ctx, left, right, top, priceH, bottom: g.priceBot, lo, hi, slice: g.slice, allCandles: this.candles, timeToX, priceToY, timeframe: this.timeframe, symbol: this.symbol };
  }

  private priceAtY(y: number): number {
    const g = this.geom;
    if (!g) return 0;
    return g.hi - ((y - g.top) / g.priceH) * (g.hi - g.lo);
  }

  private timeAtX(x: number): number | null {
    const g = this.geom;
    if (!g) return null;
    const n = g.slice.length;
    if (n === 0) return null;
    const msBias = n > 1 ? (g.slice[n - 1].t - g.slice[0].t) / (n - 1) : 60_000;
    const i = ((x - g.left) / (g.right - g.left)) * g.plotLen - 0.5;
    if (i <= 0) return g.slice[0].t + i * msBias;
    if (i >= n - 1) return g.slice[n - 1].t + (i - (n - 1)) * msBias;
    const fi = Math.floor(i), frac = i - fi;
    return g.slice[fi].t + (g.slice[fi + 1].t - g.slice[fi].t) * frac;
  }

  /** Price alert whose dashed level is closest to this canvas y position. */
  private alertNearY(y: number, tolerance: number): PriceAlert | null {
    const g = this.geom;
    if (!g) return null;
    const d = this.buildDrawCtx(this.ctx, g);
    const sym = this.symbol.toUpperCase();
    let best: PriceAlert | null = null;
    let bestDist = Infinity;
    for (const alert of listAlerts()) {
      if (alert.symbol !== sym) continue;
      const ay = d.priceToY(alert.price);
      if (ay < g.top - tolerance || ay > g.priceBot + tolerance) continue;
      const dist = Math.abs(y - ay);
      if (dist <= tolerance && dist < bestDist) {
        best = alert;
        bestDist = dist;
      }
    }
    return best;
  }

  private handleToolPointerDown(e: PointerEvent): void {
    if (!this.geom) return;
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    if (this.drawTool === "eraser") {
      // Alert lines are rendered separately from drawings, so the eraser must
      // check them explicitly. Touch gets a much wider hit target than a mouse.
      const alertTol = e.pointerType === "touch" || e.pointerType === "pen" ? 24 : 10;
      const alert = this.alertNearY(y, alertTol);
      if (alert) {
        removeAlert(alert.id);
        this.cb.onStatus(`🔔 Alert removed: ${this.symbol} ${fmtPrice(alert.price)}`);
        this.requestFitAndDraw();
        return;
      }
      const d = this.buildDrawCtx(this.ctx, this.geom);
      for (let i = this.shapes.length - 1; i >= 0; i--) {
        if (hitTest({ x, y }, this.shapes[i], d)) {
          this.shapes.splice(i, 1);
          saveShapes(this.symbol, this.timeframe, this.shapes);
          this.requestFitAndDraw();
          return;
        }
      }
      return;
    }
    const t = this.timeAtX(x), p = this.priceAtY(y);
    if (t === null) return;

    if (this.drawTool === "alert") {
      const price = p;
      const alert = addAlert(this.symbol, price);
      ensureNotificationPermission();
      this.cb.onStatus(`🔔 Alert set: ${this.symbol} crosses ${fmtPrice(price)}`);
      void alert;
      this.requestFitAndDraw();
      return;
    }

    if (DRAG_TOOLS.has(this.drawTool)) {
      this.brushPts = [{ t, p }];
      try { this.canvas.setPointerCapture(e.pointerId); } catch { /* noop */ }
      this.requestFitAndDraw();
      return;
    }

    const commit = (kind: ToolId, pts: Anchor[], text?: string): void => {
      this.shapes.push({
        id: newShapeId(),
        kind,
        a: pts[0],
        b: pts[1],
        pts,
        text,
        color: this.strokeColor,
        width: this.strokeWidth,
        createdAt: Date.now(),
      });
      saveShapes(this.symbol, this.timeframe, this.shapes);
      this.cb.onToolDone?.(this.id);
      this.requestFitAndDraw();
    };
    switch (this.drawTool) {
      case "dot": commit("dot", [{ t, p }]); return;
      case "hline": commit("hline", [{ t, p }]); return;
      case "vline": commit("vline", [{ t, p }]); return;
      case "text": {
        const v = window.prompt("Label text:", "");
        if (v && v.trim()) commit("text", [{ t, p }], v.trim());
        return;
      }
      default: {
        this.pending.push({ t, p });
        const need = CLICK_COUNT[this.drawTool] ?? 1;
        if (this.pending.length < need) { this.requestFitAndDraw(); return; }
        const pts = this.pending.slice();
        this.pending = [];
        commit(this.drawTool, pts);
      }
    }
  }

  // public API used by the sidebar in main.ts
  setDrawTool(tool: ToolId): void {
    this.drawTool = tool;
    this.pending = []; this.brushPts = null;
    this.canvas.style.cursor = tool === "cross" ? "default" : tool === "eraser" ? "pointer" : "crosshair";
    this.requestFitAndDraw();
  }

  /** Toggle vertical (price-axis) panning on this pane. */
  setPricePanMode(on: boolean): void {
    this.pricePanMode = on;
    this.canvas.style.cursor = this.drawTool === "cross"
      ? (on ? "grab" : (this.overPriceAxis(0) ? "ns-resize" : "default"))
      : this.canvas.style.cursor;
    this.requestFitAndDraw();
  }

  isPricePanMode(): boolean { return this.pricePanMode; }

  setStroke(color: string, width: number): void {
    this.strokeColor = color;
    this.strokeWidth = width;
  }

  /** Repaint (used when the theme changes). */
  redraw(): void {
    this.requestFitAndDraw();
  }

  /** Undo the most recent action: a drawing or a price alert. */
  undoDrawing(): "drawing" | "alert" | null {
    const sym = this.symbol.toUpperCase();
    let lastAlert: PriceAlert | null = null;
    for (const alert of listAlerts()) {
      if (alert.symbol !== sym) continue;
      if (!lastAlert || alert.createdAt > lastAlert.createdAt) lastAlert = alert;
    }
    const lastShape = this.shapes[this.shapes.length - 1];
    const shapeTime = lastShape?.createdAt ?? 0;
    if (lastAlert && lastAlert.createdAt >= shapeTime) {
      removeAlert(lastAlert.id);
      this.requestFitAndDraw();
      return "alert";
    }
    if (this.shapes.length > 0) {
      this.shapes.pop();
      saveShapes(this.symbol, this.timeframe, this.shapes);
      this.requestFitAndDraw();
      return "drawing";
    }
    return null;
  }

  clearDrawings(): number {
    const n = this.shapes.length;
    this.shapes = [];
    this.pending = []; this.brushPts = null;
    saveShapes(this.symbol, this.timeframe, this.shapes);
    this.requestFitAndDraw();
    return n;
  }

  cancelPendingAnchor(): void {
    this.pending = []; this.brushPts = null;
    this.requestFitAndDraw();
  }

  /** Switch this pane to another symbol without recreating it. */
  setSymbol(symbol: string): void {
    const s = symbol.trim().toUpperCase();
    if (!s || s === this.symbol) return;
    this.symbol = s;
    this.symbolEl.textContent = s;
    this.updateFsBadge();
    this.shapes = listShapes(s, this.timeframe);
    this.pending = []; this.brushPts = null;
    this.candles = [];
    this.indicator = null;
    this.lastError = null;
    this.offsetBars = 0;
    this.futureBars = DEFAULT_FUTURE_BARS;
    this.priceOffset = 0;
    this.requestFitAndDraw();
    void this.load();
  }

  onDoubleClick = (): void => {
    this.visibleBars = 160;
    this.offsetBars = 0;
    this.futureBars = DEFAULT_FUTURE_BARS;
    this.priceZoom = 1;
    this.priceOffset = 0;
    this.requestFitAndDraw();
  };

  updatePriceLabel(): void {
    const last = this.candles[this.candles.length - 1];
    if (!last) return;
    this.priceEl.textContent = fmtPrice(last.c);
    this.priceEl.classList.remove("up", "down");
    this.priceEl.classList.add(last.c >= last.o ? "up" : "down");
  }

  /** Open/close instants of the currently forming candle, derived from the
   *  candle row itself (boundaryAfter(last.t)) — never from an unrelated
   *  wall-clock bucket — plus the real milliseconds remaining until it closes. */
  private candleCountdown(): { o: number; c: number; remain: number } | null {
    const last = this.candles[this.candles.length - 1];
    if (!last) return null;
    const dur = timeframeMs(this.timeframe);
    if (dur <= 0) return null;
    const now = Date.now();
    const realC = nextBoundaryAfter(this.timeframe, last.t);
    if (now < realC) return { o: last.t, c: realC, remain: realC - now };
    // the forming bucket hasn't drawn its first tick yet (FX can stall ~10s).
    // keep the countdown alive on the wall-clock grid instead of freezing at 00;
    // give up and show 00 if the feed is a whole bucket late (market closed).
    if (now - realC <= dur) {
      const o = boundaryStart(this.timeframe, now);
      const c = nextBoundaryAfter(this.timeframe, now);
      return { o, c, remain: Math.max(0, c - now) };
    }
    return { o: last.t, c: realC, remain: 0 };
  }

  /** TradingView-style countdown to the close of the current candle. */
  private updateCountdown(): void {
    const b = this.candleCountdown();
    if (!b) { this.countdownEl.textContent = ""; this.requestFitAndDraw(); return; }
    const remain = b.remain;
    const totalSec = Math.ceil(remain / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const pad = (n: number) => String(n).padStart(2, "0");
    this.countdownEl.textContent = remain <= 0 ? "closing…" : `⏳ ${h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`}`;
    this.countdownEl.classList.toggle("closed", remain <= 0);
    // keep the canvas countdown pill (bottom time-axis row) in sync
    this.requestFitAndDraw();
  }

  remove(): void {
    this.closeLiveFeed();
    this.stopYahooPoll();
    this.stopIbPoll();
    if (this.countdownTimer !== null) { window.clearInterval(this.countdownTimer); this.countdownTimer = null; }
    try { this.resizeObs?.disconnect(); } catch { /* noop */ }
    this.wrap.remove();
    this.cb.onRemoved(this.id);
  }
}

// ─── time formatting helpers ──────────────────────────────────────────
function timeframeMs(tf: Timeframe): number {
  switch (tf) {
    case "1m": return 60_000;
    case "5m": return 300_000;
    case "15m": return 900_000;
    case "30m": return 1_800_000;
    case "1h": return 3_600_000;
    case "4h": return 14_400_000;
    case "1D": return 86_400_000;
    case "1W": return 604_800_000;
    case "1M": return 2_592_000_000;
    default: return 0;
  }
}

function nextBoundaryAfter(tf: Timeframe, t: number): number {
  const dur = timeframeMs(tf);
  if (dur <= 0) return t + 60_000;
  if (tf === "1M") {
    const d = new Date(t);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  }
  if (tf === "1W") {
    const d = new Date(t);
    const day = d.getUTCDay();                    // 0 = Sunday
    const daysToMonday = (8 - day) % 7 || 7;
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + daysToMonday);
  }
  if (tf === "1D") {
    const d = new Date(t);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  }
  return Math.floor(t / dur) * dur + dur;
}

/** Timestamp (ms) of the bucket containing instant `t`. */
function boundaryStart(tf: Timeframe, t: number): number {
  const dur = timeframeMs(tf);
  if (tf === "1M") { const d = new Date(t); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); }
  if (tf === "1W") { const d = new Date(t); const day = d.getUTCDay(); const days = (day + 6) % 7; return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - days); }
  if (tf === "1D") { const d = new Date(t); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); }
  return Math.floor(t / dur) * dur;
}

/** Timestamp (ms) at which the currently forming candle closes. */
function nextCloseAt(tf: Timeframe, now: number): number {
  return nextBoundaryAfter(tf, now);
}
function fmtPrice(v: number): string {
  if (!Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  if (abs >= 1000) return v.toFixed(2);
  if (abs >= 100) return v.toFixed(2);
  if (abs >= 10) return v.toFixed(3);
  if (abs >= 1) return v.toFixed(4);
  if (abs >= 0.01) return v.toFixed(5);
  return v.toFixed(6);
}

function fmtTime(ms: number, tf: Timeframe): string {
  const d = new Date(ms);
  const intraday = ["1m", "5m", "15m", "30m", "1h", "4h"].includes(tf);
  return intraday
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })
    : d.toLocaleDateString([], { year: "2-digit", month: "short", day: "numeric" });
}

function fmtClock(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

/** Remaining candle-close countdown as mm:ss (or h:mm:ss). */
function fmtCountdown(totalSec: number): string {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function polyline(ctx: CanvasRenderingContext2D, series: (number | null)[], offset: number, slice: Candle[], plotLen: number, yOf: (v: number) => number, color: string, left: number, right: number, width: number): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  let started = false;
  for (let i = 0; i < slice.length; i++) {
    const v = series[offset + i];
    if (v == null) continue;
    const xi = left + ((i + 0.5) / plotLen) * (right - left);
    const yi = yOf(v);
    if (!started) { ctx.moveTo(xi, yi); started = true; }
    else ctx.lineTo(xi, yi);
  }
  ctx.stroke();
}

// re-export so feed keeps types tidy
export type { Candle };
