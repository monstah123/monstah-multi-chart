// ────────────────────────────────────────────────────────────────────────────
// watchlist.ts — right-side symbol watchlist with batch quotes.
// Editable: add/remove symbols and drag rows to reorder; everything persists
// in localStorage. Clicking a row loads that symbol into the focused chart
// (or opens a new pane when nothing is focused).
// Quotes: Binance batch ticker for crypto, Yahoo spark batch for everything
// else, polled every 10s through the local /api/quotes proxy.
// ────────────────────────────────────────────────────────────────────────────

import { SYMBOL_GROUPS } from "./constants.js";
import { isBinanceSymbol, isIbSymbol } from "./feed.js";

interface Quote { price: number; changePct?: number }
interface Entry { symbol: string; group: string }
interface Row { el: HTMLElement; price: HTMLElement; chg: HTMLElement }

const LS_OPEN = "multi-chart:watchlist:v1";
const LS_ENTRIES = "multi-chart:watchlist:symbols:v1";
const POLL_MS = 10_000;
const MAX_ENTRIES = 300;
const SYMBOL_RE = /^[A-Z0-9.^=_-]{1,32}$/;

function defaultEntries(): Entry[] {
  return SYMBOL_GROUPS.flatMap((g) => g.symbols.map((symbol) => ({ symbol, group: g.group })));
}

function normalizeSymbol(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9.^=_-]/g, "");
}

function fmtQuote(p: number): string {
  if (!Number.isFinite(p)) return "—";
  if (p >= 1000) return p.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (p >= 10) return p.toFixed(2);
  if (p >= 1) return p.toFixed(3);
  if (p >= 0.01) return p.toFixed(4);
  return p.toFixed(6);
}

export interface WatchlistApi {
  refreshOpenMarks: () => void;
  isOpen: () => boolean;
}

export function initWatchlist(opts: {
  button: HTMLButtonElement;
  onPick: (symbol: string, ev?: MouseEvent) => void;
  getOpenSymbols: () => Set<string>;
  onNotice?: (msg: string) => void;
}): WatchlistApi {
  const notice = opts.onNotice ?? (() => { /* noop */ });

  // ─── persisted entries (ordered) ────────────────────────────────────
  let entries: Entry[] = [];
  let hadSavedList = false;
  try {
    const raw = localStorage.getItem(LS_ENTRIES);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (Array.isArray(parsed)) {
      hadSavedList = true;
      entries = parsed
        .filter((e): e is Entry => !!e && typeof (e as Entry).symbol === "string" && typeof (e as Entry).group === "string")
        .map((e) => ({ symbol: normalizeSymbol(e.symbol), group: e.group || "My symbols" }))
        .filter((e) => SYMBOL_RE.test(e.symbol))
        .slice(0, MAX_ENTRIES);
    }
  } catch { /* corrupted storage — fall back to defaults */ }
  if (!hadSavedList) entries = defaultEntries();

  const saveEntries = (): void => {
    try { localStorage.setItem(LS_ENTRIES, JSON.stringify(entries)); } catch { /* quota */ }
  };

  // ─── panel skeleton ─────────────────────────────────────────────────
  const panel = document.createElement("aside");
  panel.id = "watchlist";
  panel.setAttribute("aria-label", "symbol watchlist");
  panel.title = "Click a symbol to load it into the active chart · Shift-click opens a new pane";

  const head = document.createElement("div");
  head.className = "wl-head";
  const title = document.createElement("span");
  title.textContent = "Watchlist";
  const resetBtn = document.createElement("button");
  resetBtn.type = "button";
  resetBtn.className = "wl-reset";
  resetBtn.textContent = "↺";
  resetBtn.title = "restore the default watchlist";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "wl-close";
  close.textContent = "×";
  close.title = "hide the watchlist";
  const headRight = document.createElement("span");
  headRight.className = "wl-head-right";
  headRight.append(resetBtn, close);
  head.append(title, headRight);

  const body = document.createElement("div");
  body.className = "wl-body";

  const addBar = document.createElement("div");
  addBar.className = "wl-add";
  const input = document.createElement("input");
  input.type = "text";
  input.spellcheck = false;
  input.placeholder = "add symbol…";
  input.setAttribute("aria-label", "add symbol to watchlist");
  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.textContent = "+";
  addBtn.title = "add to watchlist";
  addBar.append(input, addBtn);

  panel.append(head, body, addBar);
  document.body.append(panel);

  // ─── rows ───────────────────────────────────────────────────────────
  const rows = new Map<string, Row>();
  const lastQuotes = new Map<string, Quote>();
  let dragIndex: number | null = null;

  const markOpen = (): void => {
    const current = opts.getOpenSymbols();
    for (const [sym, row] of rows) row.el.classList.toggle("open", current.has(sym));
  };

  const applyQuote = (sym: string, q: Quote): void => {
    const row = rows.get(sym);
    if (!row || !Number.isFinite(q.price)) return;
    row.price.textContent = fmtQuote(q.price);
    if (typeof q.changePct === "number") {
      const up = q.changePct >= 0;
      row.chg.textContent = `${up ? "+" : ""}${q.changePct.toFixed(2)}%`;
      row.chg.classList.toggle("up", up);
      row.chg.classList.toggle("down", !up);
    }
  };

  const moveEntry = (from: number, to: number): void => {
    const moved = entries.splice(from, 1)[0];
    const insertAt = from < to ? to - 1 : to;
    const anchor = entries[Math.min(insertAt, entries.length - 1)];
    if (anchor) moved.group = anchor.group; // adopt the target section
    entries.splice(Math.max(0, Math.min(entries.length, insertAt)), 0, moved);
    saveEntries();
    render();
  };

  function render(): void {
    const scroll = body.scrollTop;
    rows.clear();
    body.textContent = "";
    let lastGroup = "";
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry.group !== lastGroup) {
        lastGroup = entry.group;
        const gh = document.createElement("div");
        gh.className = "wl-group";
        gh.textContent = entry.group;
        body.append(gh);
      }
      const el = document.createElement("div");
      el.className = "wl-row";
      el.draggable = true;
      el.tabIndex = 0;
      el.setAttribute("role", "button");
      el.title = `open ${entry.symbol} — shift-click for a new pane, drag to reorder`;
      const name = document.createElement("span");
      name.className = "wl-sym";
      name.textContent = entry.symbol;
      const price = document.createElement("span");
      price.className = "wl-price";
      price.textContent = "—";
      const chg = document.createElement("span");
      chg.className = "wl-chg";
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "wl-remove";
      remove.textContent = "×";
      remove.title = `remove ${entry.symbol}`;
      el.append(name, price, chg, remove);

      el.addEventListener("click", (ev) => opts.onPick(entry.symbol, ev));
      el.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); opts.onPick(entry.symbol); }
      });
      remove.addEventListener("click", (ev) => {
        ev.stopPropagation();
        entries = entries.filter((e) => e.symbol !== entry.symbol);
        lastQuotes.delete(entry.symbol);
        saveEntries();
        render();
        notice(`Removed ${entry.symbol} from watchlist`);
      });

      el.addEventListener("dragstart", (ev) => {
        dragIndex = entries.findIndex((e) => e.symbol === entry.symbol);
        el.classList.add("dragging");
        if (ev.dataTransfer) { ev.dataTransfer.effectAllowed = "move"; ev.dataTransfer.setData("text/plain", entry.symbol); }
      });
      el.addEventListener("dragend", () => {
        el.classList.remove("dragging");
        for (const r of rows.values()) r.el.classList.remove("drag-over");
        dragIndex = null;
      });
      el.addEventListener("dragover", (ev) => { ev.preventDefault(); el.classList.add("drag-over"); });
      el.addEventListener("dragleave", () => el.classList.remove("drag-over"));
      el.addEventListener("drop", (ev) => {
        ev.preventDefault();
        el.classList.remove("drag-over");
        if (dragIndex === null) return;
        const target = entries.findIndex((e) => e.symbol === entry.symbol);
        if (target < 0 || target === dragIndex) return;
        moveEntry(dragIndex, target);
      });

      body.append(el);
      const row: Row = { el, price, chg };
      rows.set(entry.symbol, row);
      const cached = lastQuotes.get(entry.symbol);
      if (cached) applyQuote(entry.symbol, cached);
    }
    markOpen();
    body.scrollTop = scroll;
  }

  // ─── add / reset ────────────────────────────────────────────────────
  const addSymbol = (): void => {
    const sym = normalizeSymbol(input.value);
    if (!SYMBOL_RE.test(sym)) { notice("Enter a valid symbol, e.g. EURUSD=X, SOLUSDT, NVDA"); return; }
    if (entries.some((e) => e.symbol === sym)) { notice(`${sym} is already in the watchlist`); input.value = ""; return; }
    if (entries.length >= MAX_ENTRIES) { notice("Watchlist is full"); return; }
    entries.push({ symbol: sym, group: "My symbols" });
    saveEntries();
    input.value = "";
    render();
    notice(`Added ${sym} to watchlist`);
    void refreshQuotes();
  };
  addBtn.addEventListener("click", addSymbol);
  input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); addSymbol(); } });
  resetBtn.addEventListener("click", () => {
    entries = defaultEntries();
    lastQuotes.clear();
    saveEntries();
    render();
    notice("Watchlist restored to defaults");
    void refreshQuotes();
  });

  // ─── quotes ─────────────────────────────────────────────────────────
  async function refreshQuotes(): Promise<void> {
    const symbols = [...new Set(entries.map((e) => e.symbol))];
    if (symbols.length === 0) return;
    const binance = symbols.filter((s) => isBinanceSymbol(s));
    // IBKR Pro bridge serves FX pairs and plain US stock tickers (it subscribes
    // on demand and falls back to Yahoo spark server-side per symbol).
    // Indices (^GSPC), futures (GC=F) and other exotic symbols stay on Yahoo spark.
    const isBridgeEligible = (s: string): boolean =>
      isIbSymbol(s) || /^[A-Z][A-Z0-9.\-]{0,9}$/.test(s);
    const ib = symbols.filter((s) => !isBinanceSymbol(s) && isBridgeEligible(s));
    const ibSet = new Set(ib);
    const yahoo = symbols.filter((s) => !isBinanceSymbol(s) && !ibSet.has(s));
    const url = `/api/quotes?binance=${encodeURIComponent(binance.join(","))}&ib=${encodeURIComponent(ib.join(","))}&yahoo=${encodeURIComponent(yahoo.join(","))}`;
    console.log('[Watchlist] Fetching quotes for:', { binance, ib, yahoo, url });
    try {
      const r = await fetch(url, { cache: "no-store" });
      console.log('[Watchlist] Response status:', r.status);
      if (!r.ok) return;
      const j = (await r.json()) as { quotes?: Record<string, Quote> };
      console.log('[Watchlist] Quotes received:', j.quotes);
      for (const [sym, q] of Object.entries(j.quotes ?? {})) {
        lastQuotes.set(sym, q);
        applyQuote(sym, q);
      }
      markOpen();
    } catch (e) { console.warn('[Watchlist] Fetch error:', e); }
  }

  // ─── open / close ───────────────────────────────────────────────────
  let open = false;
  let timer: number | null = null;

  function setOpen(v: boolean): void {
    console.log('[Watchlist] setOpen:', v);
    open = v;
    document.body.classList.toggle("wl-open", v);
    opts.button.classList.toggle("pressed", v);
    opts.button.setAttribute("aria-expanded", String(v));
    try { localStorage.setItem(LS_OPEN, v ? "1" : "0"); } catch { /* ignore */ }
    if (v) {
      markOpen();
      void refreshQuotes();
      if (timer === null) timer = window.setInterval(() => { void refreshQuotes(); }, POLL_MS);
    } else if (timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
  }

  opts.button.addEventListener("click", () => setOpen(!open));
  close.addEventListener("click", () => setOpen(false));

  render();

  let persisted = false;
  try { persisted = localStorage.getItem(LS_OPEN) === "1"; } catch { /* ignore */ }
  setOpen(persisted);

  return {
    refreshOpenMarks: markOpen,
    isOpen: () => open,
  };
}
