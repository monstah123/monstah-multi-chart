// ────────────────────────────────────────────────────────────────────────────
// alerts.ts — price-level alerts with sound + browser notifications + toasts.
// Alerts are stored per symbol in localStorage, checked whenever the pane sees
// a new price, and removed automatically once they fire.
// ────────────────────────────────────────────────────────────────────────────

export interface PriceAlert {
  id: string;
  symbol: string;
  price: number;
  createdAt: number;
}

const KEY = "mc-alerts:v1";
const lastPrice = new Map<string, number>();
let cache: PriceAlert[] | null = null;

function read(): PriceAlert[] {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    cache = Array.isArray(arr)
      ? arr.filter(
          (a): a is PriceAlert =>
            !!a && typeof (a as PriceAlert).symbol === "string" && Number.isFinite((a as PriceAlert).price),
        )
      : [];
  } catch { cache = []; }
  return cache;
}

function write(list: PriceAlert[]): void {
  cache = list;
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* quota */ }
}

export function listAlerts(): PriceAlert[] { return read(); }

export function addAlert(symbol: string, price: number): PriceAlert {
  const alert: PriceAlert = { id: Math.random().toString(36).slice(2, 9) + Date.now().toString(36), symbol: symbol.toUpperCase(), price, createdAt: Date.now() };
  const list = read();
  list.push(alert);
  write(list);
  refreshUi();
  return alert;
}

export function removeAlert(id: string): void {
  write(read().filter((a) => a.id !== id));
  refreshUi();
}

export function clearAlerts(): void {
  write([]);
  refreshUi();
}

// ─── sound / notification / toast ────────────────────────────────────
function beep(): void {
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.value = 0.12;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    window.setTimeout(() => { osc.frequency.value = 1320; }, 150);
    window.setTimeout(() => { osc.stop(); void ctx.close(); }, 420);
  } catch { /* audio blocked */ }
}

export function ensureNotificationPermission(): void {
  try {
    if (typeof Notification === "undefined") return;
    if (Notification.permission === "default") void Notification.requestPermission();
  } catch { /* ignore */ }
}

function notifyBrowser(title: string, body: string): void {
  try {
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      new Notification(title, { body, tag: "mc-alert", silent: false });
    }
  } catch { /* ignore */ }
}

let toastHost: HTMLElement | null = null;
function toast(text: string, kind: "alert" | "info" = "info"): void {
  if (!toastHost) {
    toastHost = document.createElement("div");
    toastHost.id = "toastHost";
    document.body.append(toastHost);
  }
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = text;
  toastHost.append(el);
  window.setTimeout(() => { el.classList.add("fade"); }, 4200);
  window.setTimeout(() => { el.remove(); }, 5200);
}

// ─── checking ────────────────────────────────────────────────────────
const fmt = (v: number): string => (v >= 1000 ? v.toFixed(2) : v >= 1 ? v.toFixed(3) : v.toFixed(5));

/** Feed the latest price; fires + removes alerts crossed since the previous tick. */
export function checkPrice(symbol: string, price: number): PriceAlert[] {
  const sym = symbol.toUpperCase();
  const prev = lastPrice.get(sym);
  if (!Number.isFinite(price)) return [];
  lastPrice.set(sym, price);
  if (prev === undefined) return []; // first tick only sets the baseline
  const alerts = read();
  const hit = alerts.filter(
    (a) => a.symbol === sym && ((prev < a.price && price >= a.price) || (prev > a.price && price <= a.price)),
  );
  if (hit.length === 0) return [];
  const hitIds = new Set(hit.map((a) => a.id));
  write(alerts.filter((a) => !hitIds.has(a.id)));
  for (const a of hit) {
    beep();
    notifyBrowser(`⚡ ${a.symbol} alert`, `${a.symbol} crossed ${fmt(a.price)} — now ${fmt(price)}`);
    toast(`⚡ ${a.symbol} crossed ${fmt(a.price)} (now ${fmt(price)})`, "alert");
  }
  refreshUi();
  return hit;
}

// ─── UI ──────────────────────────────────────────────────────────────
let panelEl: HTMLElement | null = null;
let panelBody: HTMLElement | null = null;
let toggleBtn: HTMLButtonElement | null = null;

function updateBadge(): void {
  if (!toggleBtn) return;
  const n = read().length;
  toggleBtn.textContent = n > 0 ? `🔔 Alerts (${n})` : "🔔 Alerts";
}

function renderPanelBody(): void {
  if (!panelBody) return;
  panelBody.textContent = "";
  const alerts = read();
  if (alerts.length === 0) {
    const empty = document.createElement("div");
    empty.className = "alerts-empty";
    empty.textContent = "No alerts. Pick the 🔔 alert tool on the chart rail, then click a price level.";
    panelBody.append(empty);
    return;
  }
  for (const a of [...alerts].sort((x, y) => x.symbol.localeCompare(y.symbol))) {
    const row = document.createElement("div");
    row.className = "alert-row";
    const sym = document.createElement("span");
    sym.className = "alert-sym";
    sym.textContent = a.symbol;
    const price = document.createElement("span");
    price.className = "alert-price";
    price.textContent = fmt(a.price);
    const del = document.createElement("button");
    del.type = "button";
    del.className = "alert-del";
    del.textContent = "×";
    del.title = "delete alert";
    del.addEventListener("click", () => removeAlert(a.id));
    row.append(sym, price, del);
    panelBody.append(row);
  }
}

export function refreshUi(): void {
  updateBadge();
  renderPanelBody();
}

export function initAlertsPanel(opts: { button: HTMLButtonElement; onNotice?: (msg: string) => void }): void {
  toggleBtn = opts.button;
  const note = opts.onNotice ?? (() => { /* noop */ });

  const panel = document.createElement("aside");
  panel.id = "alertsPanel";
  panel.setAttribute("aria-label", "price alerts");

  const head = document.createElement("div");
  head.className = "alerts-head";
  const title = document.createElement("span");
  title.textContent = "Price alerts";
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "alerts-clear";
  clear.textContent = "clear all";
  clear.addEventListener("click", () => { clearAlerts(); note("All alerts cleared"); });
  const close = document.createElement("button");
  close.type = "button";
  close.className = "alerts-close";
  close.textContent = "×";
  head.append(title, clear, close);

  panelBody = document.createElement("div");
  panelBody.className = "alerts-body";
  panel.append(head, panelBody);
  document.body.append(panel);
  panelEl = panel;

  const setOpen = (v: boolean): void => {
    if (!panelEl) return;
    panelEl.classList.toggle("open", v);
    opts.button.classList.toggle("pressed", v);
    document.body.classList.toggle("alerts-open", v);
    if (v) renderPanelBody();
  };
  opts.button.addEventListener("click", () => setOpen(!panelEl?.classList.contains("open")));
  close.addEventListener("click", () => setOpen(false));

  refreshUi();
}
