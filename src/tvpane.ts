// ────────────────────────────────────────────────────────────────────
// TVPane — an alternate pane backed by the official TradingView widget.
//
// Additive by design: native ChartPane is untouched and remains the
// default. TV panes are for when you want TradingView's own chart engine
// (100+ indicators, drawing suite, replay) instead of the local canvas.
//
// Data note: the widget streams from TradingView's feed. FX/crypto are
// real-time; US equities are delayed unless the viewer's TV plan upgrades
// the feed. The app's own /api/quotes watchlist is unaffected.
//
// Attribution: TradingView's logo in the widget's lower-left corner is
// required by their embed terms and cannot be removed.
// ────────────────────────────────────────────────────────────────────

import type { Timeframe } from "./types.js";
import type { PaneCallbacks } from "./pane.js";
import type { ToolId } from "./drawtools.js";
import { themeId } from "./theme.js";

// tv.js exposes `window.TradingView.widget` after the script loads.
interface TradingViewWidgetCtor {
  new (options: Record<string, unknown>): unknown;
}

declare global {
  interface Window {
    TradingView?: { widget: TradingViewWidgetCtor };
  }
}

// ─── symbol / timeframe translation ──────────────────────────────────
// The rest of the app speaks its native symbols (BTCUSDT, EURUSD=X, ^GSPC,
// GC=F, AAPL). TradingView wants EXCHANGE:TICKER (or a resolvable ticker).
const INDEX_TO_TV: Record<string, string> = {
  "^GSPC": "SP:SPX",
  "^DJI": "TVC:DJI",
  "^IXIC": "TVC:IXIC",
  "^RUT": "TVC:RUT",
  "^VIX": "TVC:VIX",
};

const FUTURES_TO_TV: Record<string, string> = {
  "GC=F": "COMEX:GC1!",
  "SI=F": "COMEX:SI1!",
  "CL=F": "NYMEX:CL1!",
  "NG=F": "NYMEX:NG1!",
};

// Same base-length guard the local feed uses so GBTC stays an equity.
const CRYPTO_RE = /^([A-Z0-9]{3,})(USDT|USDC|FDUSD|TUSD|PYUSD|BTC|ETH|BNB)$/;

export function toTvSymbol(raw: string): string {
  const s = raw.trim().toUpperCase();
  if (!s) return "BINANCE:BTCUSDT";
  if (s.includes(":")) return s;                       // already TV format
  if (INDEX_TO_TV[s]) return INDEX_TO_TV[s];
  if (FUTURES_TO_TV[s]) return FUTURES_TO_TV[s];
  if (/^[A-Z]{6}=X$/.test(s)) return `FX:${s.slice(0, 6)}`;
  if (CRYPTO_RE.test(s)) return `BINANCE:${s}`;
  return s;                                            // AAPL, SPY, BRK.B…
}

const TF_TO_TV: Record<Timeframe, string> = {
  "1m": "1",
  "5m": "5",
  "15m": "15",
  "30m": "30",
  "1h": "60",
  "4h": "240",
  "1D": "D",
  "1W": "W",
  "1M": "M",
};

function tvTheme(): "dark" | "light" {
  return themeId() === "daylight" ? "light" : "dark";
}

// ─── one shared script load ──────────────────────────────────────────
let scriptPromise: Promise<void> | null = null;

function loadWidgetScript(): Promise<void> {
  if (window.TradingView?.widget) return Promise.resolve();
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://s3.tradingview.com/tv.js";
    script.async = true;
    script.onload = () => {
      if (window.TradingView?.widget) resolve();
      else reject(new Error("TradingView script loaded but the widget API is missing"));
    };
    script.onerror = () => {
      scriptPromise = null;
      reject(new Error("Could not load the TradingView widget script"));
    };
    document.head.append(script);
  });

  return scriptPromise;
}

// ─── pane ────────────────────────────────────────────────────────────
export class TVPane {
  readonly id: number;
  symbol: string;
  timeframe: Timeframe;
  readonly kind = "tv" as const;
  wrap!: HTMLElement;

  private cb: PaneCallbacks;
  private headerEl!: HTMLElement;
  private symbolEl!: HTMLElement;
  private tfSelect!: HTMLSelectElement;
  private expandBtn!: HTMLButtonElement;
  private mountEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private fsBadge: HTMLElement | null = null;
  private fullscreen = false;
  private pricePan = false;

  private renderSeq = 0;
  private renderedFor = "";
  private themeAtRender = "";
  private frameTimer: number | null = null;
  private resizeObs?: ResizeObserver;
  private resizeTimer: number | null = null;

  constructor(id: number, symbol: string, timeframe: Timeframe, cb: PaneCallbacks) {
    this.id = id;
    this.symbol = symbol.trim().toUpperCase();
    this.timeframe = timeframe;
    this.cb = cb;
    this.buildDom();
  }

  private buildDom(): void {
    this.wrap = document.createElement("div");
    this.wrap.className = "pane pane-tv";
    this.wrap.dataset.paneId = String(this.id);

    this.headerEl = document.createElement("div");
    this.headerEl.className = "pane-header";

    this.symbolEl = document.createElement("span");
    this.symbolEl.className = "symbol";
    this.symbolEl.textContent = this.symbol;

    this.tfSelect = document.createElement("select");
    this.tfSelect.title = "timeframe";
    for (const t of ["1m", "5m", "15m", "30m", "1h", "4h", "1D", "1W", "1M"] as Timeframe[]) {
      const opt = new Option(t, t);
      if (t === this.timeframe) opt.selected = true;
      this.tfSelect.append(opt);
    }
    this.tfSelect.addEventListener("change", () => {
      this.setTimeframe(this.tfSelect.value as Timeframe);
    });

    const nativeBtn = document.createElement("button");
    nativeBtn.textContent = "Native";
    nativeBtn.className = "kind-btn";
    nativeBtn.title = "switch this pane back to the built-in chart engine";
    nativeBtn.addEventListener("click", () => this.cb.onConvert?.(this.id, "native"));

    const badge = document.createElement("span");
    badge.className = "tv-badge";
    badge.textContent = "TRADINGVIEW";
    badge.title = "streamed by TradingView (attribution logo is required)";

    this.expandBtn = document.createElement("button");
    this.expandBtn.textContent = "⤢";
    this.expandBtn.title = "fullscreen this pane (Esc or ⤡ to exit)";
    this.expandBtn.className = "expand-btn";
    this.expandBtn.addEventListener("click", () => this.toggleFullscreen());

    const removeBtn = document.createElement("button");
    removeBtn.textContent = "×";
    removeBtn.title = "remove pane";
    removeBtn.addEventListener("click", () => this.remove());

    this.headerEl.append(this.symbolEl, this.tfSelect, nativeBtn, badge, this.expandBtn, removeBtn);
    this.wrap.append(this.headerEl);

    this.mountEl = document.createElement("div");
    this.mountEl.className = "tv-mount";

    this.statusEl = document.createElement("div");
    this.statusEl.className = "tv-status";
    this.statusEl.hidden = true;

    this.wrap.append(this.mountEl, this.statusEl);

    this.resizeObs = new ResizeObserver(() => {
      if (this.resizeTimer !== null) window.clearTimeout(this.resizeTimer);
      this.resizeTimer = window.setTimeout(() => {
        this.resizeTimer = null;
        window.dispatchEvent(new Event("resize"));
      }, 120);
    });
    this.resizeObs.observe(this.wrap);
  }

  // ─── lifecycle ─────────────────────────────────────────────────────
  load(): void {
    void this.render();
  }

  setSymbol(symbol: string): void {
    const next = symbol.trim().toUpperCase();
    if (!next || next === this.symbol) return;
    this.symbol = next;
    this.symbolEl.textContent = next;
    this.updateFsBadge();
    void this.render();
    this.cb.onStatus(`Pane ${this.id} → ${next} (TradingView)`);
  }

  setTimeframe(tf: Timeframe): void {
    if (tf === this.timeframe) return;
    this.timeframe = tf;
    this.tfSelect.value = tf;
    this.updateFsBadge();
    void this.render();
    this.cb.onStatus(`Pane ${this.id} → ${this.symbol} ${tf} (TradingView)`);
  }

  /** Re-render only when the theme actually changed (widget props are immutable). */
  redraw(): void {
    if (this.themeAtRender !== themeId()) void this.render();
  }

  remove(): void {
    this.dispose();
    this.cb.onRemoved(this.id);
  }

  /** Cleanup without notifying the host — used when converting pane kinds. */
  dispose(): void {
    this.renderSeq++;
    this.clearFrameWatch();
    if (this.resizeTimer !== null) { window.clearTimeout(this.resizeTimer); this.resizeTimer = null; }
    try { this.resizeObs?.disconnect(); } catch { /* noop */ }
    this.removeFsBadge();
    this.wrap.remove();
  }

  // ─── widget ────────────────────────────────────────────────────────
  private async render(): Promise<void> {
    const seq = ++this.renderSeq;
    const key = `${this.symbol}|${this.timeframe}|${tvTheme()}`;
    if (key === this.renderedFor) return;
    this.renderedFor = key;

    this.showStatus("Loading TradingView chart…", false);
    try {
      await loadWidgetScript();
    } catch (err) {
      if (seq !== this.renderSeq) return;
      this.showStatus((err as Error).message, true);
      this.renderedFor = "";
      return;
    }
    if (seq !== this.renderSeq) return;

    const host = document.createElement("div");
    host.className = "tv-widget";
    host.id = `tv_pane_${this.id}_${seq}`;
    this.mountEl.replaceChildren(host);

    try {
      const widget = window.TradingView?.widget;
      if (!widget) throw new Error("TradingView widget API unavailable");
      new widget({
        container_id: host.id,
        autosize: true,
        symbol: toTvSymbol(this.symbol),
        interval: TF_TO_TV[this.timeframe],
        timezone: "Etc/UTC",
        theme: tvTheme(),
        style: "1",
        locale: "en",
        enable_publishing: false,
        allow_symbol_change: false,
        hide_side_toolbar: false,
        withdateranges: true,
        save_image: true,
        details: false,
        hotlist: false,
        calendar: false,
        studies: [],
      });
      this.themeAtRender = themeId();
      this.watchForFrame(host, seq);
    } catch (err) {
      this.showStatus((err as Error).message, true);
      this.renderedFor = "";
    }
  }

  private watchForFrame(host: HTMLElement, seq: number): void {
    this.clearFrameWatch();
    const started = Date.now();
    this.frameTimer = window.setInterval(() => {
      if (seq !== this.renderSeq || !host.isConnected) { this.clearFrameWatch(); return; }
      if (host.querySelector("iframe")) {
        this.clearFrameWatch();
        this.showStatus("", false);
      } else if (Date.now() - started > 15_000) {
        this.clearFrameWatch();
        this.showStatus("TradingView did not load. Check your connection, then retry.", true);
      }
    }, 150);
  }

  private clearFrameWatch(): void {
    if (this.frameTimer !== null) { window.clearInterval(this.frameTimer); this.frameTimer = null; }
  }

  private showStatus(message: string, retry: boolean): void {
    this.statusEl.replaceChildren();
    if (!message) { this.statusEl.hidden = true; return; }
    this.statusEl.hidden = false;
    const text = document.createElement("span");
    text.textContent = message;
    this.statusEl.append(text);
    if (retry) {
      const btn = document.createElement("button");
      btn.className = "btn";
      btn.textContent = "Retry";
      btn.addEventListener("click", () => { this.renderedFor = ""; void this.render(); });
      this.statusEl.append(btn);
    }
  }

  // ─── fullscreen (same CSS contract as ChartPane) ───────────────────
  toggleFullscreen(): void {
    this.fullscreen = !this.fullscreen;
    this.wrap.classList.toggle("fullscreen", this.fullscreen);
    this.expandBtn.textContent = this.fullscreen ? "⤡" : "⤢";
    this.expandBtn.title = this.fullscreen ? "exit fullscreen (Esc)" : "fullscreen this pane (Esc / ⤡)";
    this.cb.onStatus(this.fullscreen ? `⛶ ${this.symbol} — Esc or ⤡ to exit fullscreen` : "Back in grid view");
    this.updateFsBadge();
    window.setTimeout(() => window.dispatchEvent(new Event("resize")), 80);
  }

  refreshFsBadge(): void { this.updateFsBadge(); }

  private updateFsBadge(): void {
    if (this.fullscreen) {
      if (!this.fsBadge) {
        this.fsBadge = document.createElement("div");
        this.fsBadge.className = "fs-badge";
        this.fsBadge.setAttribute("aria-hidden", "true");
        document.body.append(this.fsBadge);
      }
      this.fsBadge.textContent = `${this.symbol}  ${this.timeframe}  ·  TradingView`;
      this.fsBadge.style.display = "block";
    } else {
      this.removeFsBadge();
    }
  }

  private removeFsBadge(): void {
    if (this.fsBadge) { this.fsBadge.remove(); this.fsBadge = null; }
  }

  // ─── interface parity with ChartPane (inert where it has no meaning) ─
  setDrawTool(_tool: ToolId): void { /* widget owns its own toolbar */ }
  setStroke(_color: string, _width: number): void { /* noop */ }
  cancelPendingAnchor(): void { /* noop */ }
  undoDrawing(): "drawing" | "alert" | null { return null; }
  clearDrawings(): number { return 0; }
  setPricePanMode(on: boolean): void { this.pricePan = on; }
  isPricePanMode(): boolean { return this.pricePan; }
}
