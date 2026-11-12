// ────────────────────────────────────────────────────────────────────
// Multi-Chart — orchestrator: toolbar, grid layout, hotkeys, import/export
// ────────────────────────────────────────────────────────────────────

import { ChartPane } from "./pane.js";
import { DEFAULT_SYMBOLS, SYMBOL_GROUPS, TF, STORAGE_KEY_LAYOUT } from "./constants.js";
import { PALETTE, WIDTHS, CLICK_COUNT } from "./drawtools.js";
import type { ToolId } from "./drawtools.js";
import { initWatchlist } from "./watchlist.js";
import { initAlertsPanel } from "./alerts.js";
import { initTheme, setTheme, themeId, THEMES } from "./theme.js";
import type { Timeframe } from "./types.js";

type Layout = { cols: number; rows: number; label: string };
const LAYOUTS: Record<string, Layout> = {
  "1×1": { cols: 1, rows: 1, label: "1 chart" },
  "2×1": { cols: 2, rows: 1, label: "2 charts side-by-side" },
  "1×2": { cols: 1, rows: 2, label: "2 charts stacked" },
  "2×2": { cols: 2, rows: 2, label: "4 charts (2×2)" },
  "3×2": { cols: 3, rows: 2, label: "6 charts (3×2)" },
};
const LAYOUT_ORDER = ["1×1", "2×1", "1×2", "2×2", "3×2"];

const state = {
  panes: [] as ChartPane[],
  layoutKey: "2×2",
  lastTimeframe: "1m" as Timeframe,
  status: "" as string,
};

const viewport = document.getElementById("viewport")!;
const symbolInput = document.getElementById("symbolInput") as HTMLInputElement;
const symbolList = document.getElementById("symbolList") as HTMLDataListElement;
const timeframeRow = document.getElementById("timeframeRow") as HTMLElement;
const layoutRow = document.getElementById("layoutRow") as HTMLElement;
const statusText = document.getElementById("statusText") as HTMLElement;
const addPaneBtn = document.getElementById("addPaneBtn") as HTMLElement;
const exportBtn = document.getElementById("exportBtn") as HTMLButtonElement;
const importBtn = document.getElementById("importBtn") as HTMLButtonElement;
const importFile = document.getElementById("importFile") as HTMLInputElement;
const panToggleBtn = document.createElement("button");
panToggleBtn.id = "panToggleBtn";
panToggleBtn.className = "btn";
panToggleBtn.title = "vertical price panning — left-drag up/down on the chart body; hold Shift to scroll horizontally instead";
panToggleBtn.textContent = "↕ Pan";
// vertical panning is on by default: left-click + drag up/down on any chart
panToggleBtn.classList.toggle("active", true);
for (const p of state.panes) p.setPricePanMode(true);

function setStatus(msg: string): void {
  state.status = msg;
  statusText.textContent = msg;
}

// ─── symbol datalist (kept — used by browser autocomplete as well) ────
for (const s of DEFAULT_SYMBOLS) {
  const opt = document.createElement("option");
  opt.value = s;
  symbolList.append(opt);
}

// ─── shared dropdown helper ───────────────────────────────────────────
function makeDropdown(toggleLabel: string, title: string, buildPanel: (panel: HTMLElement) => void): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "dd";
  const toggle = document.createElement("button");
  toggle.className = "btn dd-toggle";
  toggle.title = title;
  toggle.textContent = toggleLabel;
  toggle.setAttribute("aria-expanded", "false");
  const panel = document.createElement("div");
  panel.className = "dd-panel";
  panel.setAttribute("role", "menu");

  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = wrap.classList.toggle("open");
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    closeOtherDropdowns(open ? wrap : null);
  });
  wrap.append(toggle, panel);
  buildPanel(panel);
  return wrap;
}

const openDropdowns = (): HTMLElement[] => Array.from(document.querySelectorAll(".dd.open"));
function closeOtherDropdowns(except: HTMLElement | null): void {
  for (const d of openDropdowns()) {
    if (d !== except) { d.classList.remove("open"); d.querySelector(".dd-toggle")?.setAttribute("aria-expanded", "false"); }
  }
}
document.addEventListener("click", () => closeOtherDropdowns(null));

// ─── timeframe buttons ────────────────────────────────────────────────
for (const t of TF) {
  const btn = document.createElement("button");
  btn.className = "btn tf-btn";
  btn.textContent = t.label;
  btn.dataset.tf = t.key;
  btn.setAttribute("aria-pressed", t.key === state.lastTimeframe ? "true" : "false");
  btn.addEventListener("click", () => {
    state.lastTimeframe = t.key;
    for (const b of Array.from(timeframeRow.querySelectorAll(".btn"))) {
      b.setAttribute("aria-pressed", (b as HTMLElement).dataset.tf === t.key ? "true" : "false");
    }
    for (const p of state.panes) {
      p.timeframe = t.key;
      (p as unknown as { tfSelect: HTMLSelectElement }).tfSelect.value = t.key;
      void p.load();
    }
  });
  timeframeRow.append(btn);
}

// ─── grouped symbol picker (choose-from dropdown next to the input) ───
{
  const picker = makeDropdown("▾", "Choose from default symbols", (panel) => {
    for (const grp of SYMBOL_GROUPS) {
      const h = document.createElement("div");
      h.className = "dd-group";
      h.textContent = grp.group;
      panel.append(h);
      for (const sym of grp.symbols) {
        const item = document.createElement("button");
        item.className = "dd-item";
        item.textContent = sym;
        item.addEventListener("click", (e) => {
          e.stopPropagation();
          symbolInput.value = sym;
          addPane(sym, state.lastTimeframe); // click now opens the chart straight away
          closeOtherDropdowns(null);
        });
        panel.append(item);
      }
    }
  });
  picker.style.marginLeft = "2px";
  symbolInput.parentElement?.append(picker);
}

// ─── layout dropdown ("pick how many charts", TradingView-style) ─────
function glyph(cols: number, rows: number, active: Record<string, boolean>): HTMLElement {
  const g = document.createElement("span");
  g.className = "layout-glyph";
  g.style.gridTemplateColumns = `repeat(${cols}, 12px)`;
  g.style.gridTemplateRows = `repeat(${rows}, 8px)`;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = document.createElement("span");
      if (active[`${r},${c}`]) cell.className = "on";
      g.append(cell);
    }
  }
  return g;
}

{
  const layoutDD = makeDropdown("Charts ▾", "Choose how many charts to show", (panel) => {
    for (const key of LAYOUT_ORDER) {
      const L = LAYOUTS[key];
      const item = document.createElement("button");
      item.className = "dd-item layout-dd-item";
      item.dataset.layout = key;
      let glyphActive: Record<string, boolean> = {};
      if (key === "1×1") glyphActive = { "0,0": true };
      else if (key === "2×1") glyphActive = { "0,0": true, "0,1": true };
      else if (key === "1×2") glyphActive = { "0,0": true, "1,0": true };
      else if (key === "2×2") glyphActive = { "0,0": true, "0,1": true, "1,0": true, "1,1": true };
      else if (key === "3×2") {
        for (let r = 0; r < 2; r++) for (let c = 0; c < 3; c++) glyphActive[`${r},${c}`] = true;
      }
      const g = glyph(L.cols, L.rows, glyphActive);
      const label = document.createElement("span");
      label.textContent = L.label;
      item.append(g, label);
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        applyLayout(key);
        closeOtherDropdowns(null);
      });
      panel.append(item);
    }
  });
  layoutRow.append(layoutDD);
}

// ─── whole-workspace fullscreen button ────────────────────────────────
{
  const fsBtn = document.createElement("button");
  fsBtn.className = "btn";
  fsBtn.id = "workspaceFsBtn";
  fsBtn.title = "fullscreen the whole workspace (F11)";
  fsBtn.textContent = "⛶";
  fsBtn.addEventListener("click", () => toggleWorkspaceFullscreen());
  layoutRow.append(fsBtn);
  // vertical price pan toggle
  panToggleBtn.addEventListener("click", () => {
    const on = state.panes.length > 0 ? !state.panes[0].isPricePanMode() : true;
    for (const p of state.panes) p.setPricePanMode(on);
    panToggleBtn.classList.toggle("active", on);
    panToggleBtn.textContent = on ? "↕ Pan ✓" : "↕ Pan";
    setStatus(on ? "Price-axis vertical panning enabled — left-drag up/down on any chart" : "Price-axis vertical panning disabled");
  });
  layoutRow.append(panToggleBtn);
}
function toggleWorkspaceFullscreen(): void {
  if (document.fullscreenElement) {
    void document.exitFullscreen().catch(() => setStatus("Could not exit fullscreen"));
  } else {
    void document.documentElement.requestFullscreen().catch(() => setStatus("Fullscreen request was denied"));
  }
}

// ─── theme picker ─────────────────────────────────────────────────────
initTheme();
{
  let themeDD!: HTMLElement;
  function markThemeChoice(): void {
    themeDD.querySelectorAll<HTMLElement>(".dd-item").forEach((el) => {
      el.classList.toggle("active", el.dataset.theme === themeId());
    });
  }
  themeDD = makeDropdown("🎨", "chart theme", (panel) => {
    for (const t of THEMES) {
      const item = document.createElement("button");
      item.className = "dd-item";
      item.dataset.theme = t.id;
      item.textContent = t.label;
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        setTheme(t.id);
        markThemeChoice();
        closeOtherDropdowns(null);
        for (const p of state.panes) p.redraw();
        setStatus(`Theme: ${t.label}`);
      });
      panel.append(item);
    }
  });
  themeDD.addEventListener("click", () => markThemeChoice(), true);
  layoutRow.append(themeDD);
  markThemeChoice();
}

// ─── layout application ───────────────────────────────────────────────
// Default keeps the explicit spec rule: overflow panes stay alive but are HIDDEN.
// One affordance flips the hidden ones visible; the choice is remembered.
const VIS_KEY = "multi-chart:vis:v1";
let expandedHidden = false;
try { expandedHidden = localStorage.getItem(VIS_KEY) === "1"; } catch { /* private mode */ }
const hiddenToggle = document.createElement("button");
hiddenToggle.id = "hiddenToggle";
hiddenToggle.className = "btn";
hiddenToggle.title = "show hidden panes (off-grid), click again to re-hide them";
hiddenToggle.textContent = "👁 Panes";
hiddenToggle.addEventListener("click", () => {
  expandedHidden = !expandedHidden;
  try { localStorage.setItem(VIS_KEY, expandedHidden ? "1" : "0"); } catch { /* ignore */ }
  applyLayout(state.layoutKey);
  setStatus(expandedHidden ? "All panes visible (outside grid slots)" : "Overflow panes hidden again");
});
layoutRow.prepend(hiddenToggle);
function applyLayout(key: string): void {
  state.layoutKey = key;
  const { cols, rows } = LAYOUTS[key];
  viewport.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  viewport.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
  viewport.style.gridAutoRows = "1fr";
  const slots = cols * rows;
  state.panes.forEach((p, i) => { p.wrap.style.display = (i < slots || expandedHidden) ? "" : "none"; });
  const overflow = Math.max(0, state.panes.length - slots);
  hiddenToggle.classList.toggle("pressed", expandedHidden);
  if (overflow === 0) {
    // nothing is hidden — don't offer a button that would do nothing
    expandedHidden = false;
    hiddenToggle.style.display = "none";
  } else {
    hiddenToggle.style.display = "";
    hiddenToggle.textContent = expandedHidden ? `👁 Hide ${overflow}` : `👁 Show ${overflow}`;
    hiddenToggle.title = expandedHidden
      ? `hide the ${overflow} pane(s) outside the grid`
      : `reveal the ${overflow} pane(s) outside the grid`;
  }
  saveSession();
}

// ─── panes ────────────────────────────────────────────────────────────
function addPane(symbol = symbolInput.value.trim().toUpperCase(), timeframe = state.lastTimeframe): void {
  const s = symbol || "BTCUSDT";
  const id = state.panes.length ? Math.max(...state.panes.map((p) => p.id)) + 1 : 1;
  symbolInput.value = s;
  const pane = new ChartPane(id, s, timeframe, {
    onStatus: setStatus,
    onRemoved: (removedId) => {
      state.panes = state.panes.filter((p) => p.id !== removedId);
      if (state.panes.length === 0) setStatus("All panes removed. Press N or + Pane.");
      applyLayout(state.layoutKey); // unhide any previously hidden panes
      saveSession();
    },
    // TradingView-style: after the drawing is placed, snap back to cursor mode
    // so the new shape is immediately draggable instead of staying sticky
    onToolDone: () => applyTool("cross"),
  });
  viewport.append(pane.wrap);
  state.panes.push(pane);
  pane.setDrawTool(activeTool);
  pane.setStroke(currentColor(), currentWidth);
  // Apply current pan mode to new pane
  const panMode = state.panes[0]?.isPricePanMode() ?? false;
  pane.setPricePanMode(panMode);
  void pane.load();
  applyLayout(state.layoutKey);
  const slots = LAYOUTS[state.layoutKey].cols * LAYOUTS[state.layoutKey].rows;
  if (!expandedHidden && state.panes.length > slots) {
    // never let a new pane disappear silently: reveal the overflow row
    expandedHidden = true;
    try { localStorage.setItem(VIS_KEY, "1"); } catch { /* ignore */ }
    applyLayout(state.layoutKey);
    setStatus(`${s} ${timeframe} added — grid was full, revealing every pane (👁 Panes to hide overflow again)`);
  }
}

// ─── saved chart setups (named workspaces) ────────────────────────────
const SAVED_KEY = "multi-chart:saved:v1";
interface SavedSetup {
  name: string;
  layoutKey: string;
  panes: { symbol: string; timeframe: Timeframe }[];
  savedAt: number;
}
function readSetups(): SavedSetup[] {
  try {
    const raw = localStorage.getItem(SAVED_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (s): s is SavedSetup =>
        !!s && typeof (s as SavedSetup).name === "string" && Array.isArray((s as SavedSetup).panes),
    );
  } catch { return []; }
}
function writeSetups(list: SavedSetup[]): void {
  try { localStorage.setItem(SAVED_KEY, JSON.stringify(list)); } catch { /* quota */ }
}

function loadSetup(s: SavedSetup): void {
  for (const p of [...state.panes]) p.remove();
  state.panes = [];
  state.layoutKey = LAYOUTS[s.layoutKey] ? s.layoutKey : "2×2";
  applyLayout(state.layoutKey);
  for (const cfg of s.panes) addPane(cfg.symbol, cfg.timeframe);
  setStatus(`Loaded “${s.name}” — ${s.panes.length} chart(s)`);
}

const saveBtn = document.createElement("button");
saveBtn.className = "btn";
saveBtn.textContent = "💾 Save";
saveBtn.title = "save the current set of open charts under a name";
saveBtn.addEventListener("click", () => {
  if (state.panes.length === 0) { setStatus("No charts to save — add a pane first."); return; }
  const suggested = `Setup ${readSetups().length + 1}`;
  const name = window.prompt("Name this chart setup:", suggested)?.trim();
  if (!name) return;
  const list = readSetups().filter((s) => s.name !== name);
  list.push({
    name,
    layoutKey: state.layoutKey,
    panes: state.panes.map((p) => ({ symbol: p.symbol, timeframe: p.timeframe })),
    savedAt: Date.now(),
  });
  writeSetups(list);
  setStatus(`Saved “${name}” — ${state.panes.length} chart(s)`);
});

const savedWrap = document.createElement("div");
savedWrap.className = "dd";
const savedToggle = document.createElement("button");
savedToggle.className = "btn dd-toggle";
savedToggle.textContent = "📁 Saved";
savedToggle.title = "load or delete saved chart setups";
savedToggle.setAttribute("aria-expanded", "false");
const savedPanel = document.createElement("div");
savedPanel.className = "dd-panel";
savedPanel.setAttribute("role", "menu");

function renderSavedPanel(): void {
  savedPanel.textContent = "";
  const list = readSetups();
  if (list.length === 0) {
    const empty = document.createElement("div");
    empty.className = "dd-empty";
    empty.textContent = "No saved setups yet — arrange your charts, then click 💾 Save.";
    savedPanel.append(empty);
    return;
  }
  for (const s of [...list].sort((a, b) => b.savedAt - a.savedAt)) {
    const row = document.createElement("div");
    row.className = "saved-row";
    const nameBtn = document.createElement("button");
    nameBtn.className = "dd-item";
    nameBtn.textContent = `${s.name} · ${s.panes.length}`;
    nameBtn.title = `${s.layoutKey}: ${s.panes.map((p) => `${p.symbol} ${p.timeframe}`).join(", ")}`;
    nameBtn.addEventListener("click", (e) => { e.stopPropagation(); closeSaved(); loadSetup(s); });
    const del = document.createElement("button");
    del.className = "saved-del";
    del.textContent = "×";
    del.title = `delete “${s.name}”`;
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      writeSetups(readSetups().filter((x) => x.name !== s.name));
      renderSavedPanel();
      setStatus(`Deleted “${s.name}”`);
    });
    row.append(nameBtn, del);
    savedPanel.append(row);
  }
}

function closeSaved(): void {
  savedWrap.classList.remove("open");
  savedToggle.setAttribute("aria-expanded", "false");
}
savedToggle.addEventListener("click", (e) => {
  e.stopPropagation();
  const open = savedWrap.classList.toggle("open");
  savedToggle.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) { closeOtherDropdowns(savedWrap); renderSavedPanel(); } else closeOtherDropdowns(null);
});
savedWrap.append(savedToggle, savedPanel);
document.addEventListener("click", (e) => { if (!savedWrap.contains(e.target as Node)) closeSaved(); });

// insert the save/load controls just before the Export button
exportBtn.before(saveBtn, savedWrap);

// ─── export / import layout ───────────────────────────────────────────
exportBtn.addEventListener("click", exportLayout);
importBtn.addEventListener("click", () => importFile.click());
importFile.addEventListener("change", () => {
  const f = importFile.files?.[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const txt = String(reader.result);
      const parsed = JSON.parse(txt) as { layoutKey?: string; panes?: { symbol: string; timeframe: Timeframe }[] };
      for (const p of [...state.panes]) p.remove();
      state.panes = [];
      if (parsed.layoutKey && LAYOUTS[parsed.layoutKey]) state.layoutKey = parsed.layoutKey;
      if (parsed.panes?.length) {
        applyLayout(state.layoutKey);
        for (const cfg of parsed.panes) addPane(cfg.symbol, cfg.timeframe);
      } else {
        addPane("BTCUSDT", "1m");
      }
      setStatus(`Imported ${parsed.panes?.length ?? 0} pane(s)`);
    } catch (err) {
      setStatus(`Import failed: ${(err as Error).message}`);
    }
  };
  reader.readAsText(f);
  importFile.value = "";
});

function exportLayout(): void {
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    layoutKey: state.layoutKey,
    panes: state.panes.map((p) => ({ symbol: p.symbol, timeframe: p.timeframe })),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `multi-chart-layout-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  setStatus("Exported layout JSON.");
}

function saveSession(): void {
  try {
    const payload = {
      layoutKey: state.layoutKey,
      panMode: state.panes.length > 0 ? state.panes[0].isPricePanMode() : true,
      panes: state.panes.map((p) => ({ symbol: p.symbol, timeframe: p.timeframe })),
    };
    localStorage.setItem(STORAGE_KEY_LAYOUT, JSON.stringify(payload));
  } catch { /* storage full or blocked — ignore */ }
}

function restoreSession(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_LAYOUT);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as { layoutKey?: string; panMode?: boolean; panes?: { symbol: string; timeframe: Timeframe }[] };
    if (parsed.layoutKey && LAYOUTS[parsed.layoutKey]) applyLayout(parsed.layoutKey);
    if (Array.isArray(parsed.panes) && parsed.panes.length !== 0) {
      for (const cfg of parsed.panes) addPane(cfg.symbol, cfg.timeframe);
      const panMode = parsed.panMode ?? true;
      for (const p of state.panes) p.setPricePanMode(panMode);
      panToggleBtn.classList.toggle("active", panMode);
      panToggleBtn.textContent = panMode ? "↕ Pan ✓" : "↕ Pan";
      setStatus(`Restored ${parsed.panes.length} pane(s) from local session.`);
      return true;
    }
  } catch { /* fall through */ }
  return false;
}

// ─── add-pane button + Enter on symbol input ──────────────────────────
addPaneBtn.addEventListener("click", () => addPane());
symbolInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); addPane(); }
});

// ─── hotkeys ──────────────────────────────────────────────────────────
window.addEventListener("keydown", (e: KeyboardEvent) => {
  const tag = document.activeElement?.tagName?.toLowerCase() ?? "";
  const inField = tag === "input" || tag === "select" || tag === "textarea";
  if (e.key === "n" || e.key === "N") {
    if (inField) return;
    e.preventDefault(); addPane(); return;
  }
  if (e.key === "Backspace") {
    if (inField) return;
    const last = state.panes[state.panes.length - 1];
    if (last) { e.preventDefault(); last.remove(); }
    return;
  }
  if (e.key === "Escape") {
    // close fullscreen pane(s), cancel in-progress drawings, close dropdowns
    let collapsed = false;
    cancelPendingDrawings();
    for (const p of state.panes) {
      if (p.wrap.classList.contains("fullscreen")) { p.toggleFullscreen(); collapsed = true; }
    }
    closeOtherDropdowns(null);
    if (!collapsed) (document.activeElement as HTMLElement | null)?.blur();
    return;
  }
  if (e.key === "F11") {
    e.preventDefault();
    toggleWorkspaceFullscreen();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    e.preventDefault(); exportLayout(); return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o") {
    e.preventDefault(); importFile.click(); return;
  }
});

// ─── drawing toolbar (left rail) ──────────────────────────────────────
// Anchors are time+price so drawings survive pan/zoom/timeframe switches.
const TOOL_DEFS: { id: ToolId; glyph: string; title: string }[] = [
  { id: "cross", glyph: "✚", title: "cursor & pan (default)" },
  { id: "dot", glyph: "●", title: "dot marker" },
  { id: "arrow", glyph: "➤", title: "arrow" },
  { id: "trend", glyph: "╱", title: "trend line" },
  { id: "ray", glyph: "→", title: "ray (extends right)" },
  { id: "hline", glyph: "─", title: "horizontal line" },
  { id: "vline", glyph: "│", title: "vertical line" },
  { id: "measure", glyph: "⤢", title: "measure move (%Δ)" },
  { id: "rect", glyph: "▭", title: "rectangle" },
  { id: "fib", glyph: "F", title: "fib retracement" },
  { id: "fibext", glyph: "⇗", title: "fibonacci extension (3 clicks)" },
  { id: "channel", glyph: "═", title: "parallel channel (3 clicks)" },
  { id: "pitchfork", glyph: "⋔", title: "andrews pitchfork (3 clicks)" },
  { id: "position", glyph: "▤", title: "long/short position tool (3 clicks)" },
  { id: "brush", glyph: "✎", title: "brush — freehand (drag)" },
  { id: "alert", glyph: "🔔", title: "price alert — click a level" },
  { id: "text", glyph: "T", title: "text label" },
  { id: "eraser", glyph: "⌫", title: "eraser (click a drawing)" },
];
const toolButtonsEl = document.getElementById("toolButtons") as HTMLElement;
const lineColorRow = document.getElementById("lineColorRow") as HTMLElement;
const lineWidthRow = document.getElementById("lineWidthRow") as HTMLElement;
const cursorInfo = document.getElementById("cursorInfo") as HTMLElement;
const toolBtns = new Map<ToolId, HTMLButtonElement>();
let activeTool: ToolId = "cross";
let focusedPane: ChartPane | null = null;

function applyTool(tool: ToolId): void {
  activeTool = tool;
  for (const p of state.panes) p.setDrawTool(tool);
  toolBtns.forEach((btn, id) => btn.classList.toggle("active", id === tool));
  cursorInfo.textContent = tool;
  const clicks = CLICK_COUNT[tool] ?? 0;
  if (tool === "cross") setStatus("Cursor mode — drag to pan, wheel to zoom, double-click to reset zoom.");
  else if (tool === "eraser") setStatus("Eraser — click any drawing on the chart to delete it.");
  else if (tool === "alert") setStatus("🔔 Alert — click a price level; you'll get a sound + browser notification when price crosses it.");
  else if (tool === "brush") setStatus("Brush — press and drag on the chart to draw freehand.");
  else if (clicks >= 2) setStatus(`${tool} — click the chart ${clicks} times. Right-click or Esc cancels.`);
  else if (tool === "text") setStatus("Text — click the chart, then type the label.");
  else setStatus(`${tool} — click once on the chart.`);
}

for (const def of TOOL_DEFS) {
  const b = document.createElement("button");
  b.className = "tool-btn";
  b.title = def.title;
  b.textContent = def.glyph;
  b.style.fontWeight = def.id === "fib" ? "700" : "";
  b.addEventListener("click", () => applyTool(def.id));
  toolButtonsEl.append(b);
  toolBtns.set(def.id, b);
}

const undoBtn = document.createElement("button");
undoBtn.className = "tool-btn";
undoBtn.title = "undo last drawing on the active chart";
undoBtn.textContent = "↺";
undoBtn.addEventListener("click", () => {
  const p = focusedPane ?? state.panes[0];
  if (p?.undoDrawing()) setStatus("Undid last drawing.");
  else setStatus("Nothing to undo on this chart.");
});
toolButtonsEl.append(undoBtn);

const clearBtn = document.createElement("button");
clearBtn.className = "tool-btn danger";
clearBtn.title = "delete every drawing on the active chart";
clearBtn.textContent = "🗑";
clearBtn.addEventListener("click", () => {
  const p = focusedPane ?? state.panes[0];
  const n = p?.clearDrawings() ?? 0;
  setStatus(n ? `Cleared ${n} drawing(s) on ${p?.symbol}.` : "No drawings on this chart.");
});
toolButtonsEl.append(clearBtn);

// color + width pickers
const colorDotEls: { el: HTMLElement; color: string }[] = [];
function applyStroke(color: string, width: number): void {
  for (const p of state.panes) p.setStroke(color, width);
  for (const c of colorDotEls) c.el.classList.toggle("active", c.color === color);
}
for (const color of PALETTE) {
  const dot = document.createElement("div");
  dot.className = "color-dot";
  dot.style.background = color;
  dot.title = color;
  dot.addEventListener("click", () => applyStroke(color, currentWidth));
  lineColorRow.append(dot);
  colorDotEls.push({ el: dot, color });
}
let currentWidth = 2;
const widthEls: { el: HTMLElement; w: number }[] = [];
function applyWidth(w: number): void {
  currentWidth = w;
  for (const p of state.panes) p.setStroke(currentColor(), w);
  for (const s of widthEls) s.el.classList.toggle("active", s.w === w);
}
function currentColor(): string {
  return colorDotEls.find((c) => c.el.classList.contains("active"))?.color ?? PALETTE[0];
}
for (const w of WIDTHS) {
  const sw = document.createElement("div");
  sw.className = "width-swatch";
  sw.title = `${w}px`;
  const bar = document.createElement("div");
  bar.style.height = `${w}px`;
  sw.append(bar);
  sw.addEventListener("click", () => applyWidth(w));
  lineWidthRow.append(sw);
  widthEls.push({ el: sw, w });
}
applyStroke(PALETTE[0], 2);
applyWidth(2);
applyTool("cross");

// drawing rail collapse — persisted, so the chart can use the full width
const RAIL_KEY = "multi-chart:rail:v1";
const railToggle = document.getElementById("railToggle") as HTMLButtonElement;
try { if (localStorage.getItem(RAIL_KEY) === "1") document.body.classList.add("rail-collapsed"); } catch { /* ignore */ }
function syncRailToggle(): void {
  const collapsed = document.body.classList.contains("rail-collapsed");
  railToggle.textContent = collapsed ? "»" : "«";
  railToggle.title = collapsed ? "show the drawing rail" : "hide the drawing rail (more chart space)";
}
syncRailToggle();
railToggle.addEventListener("click", () => {
  const collapsed = document.body.classList.toggle("rail-collapsed");
  try { localStorage.setItem(RAIL_KEY, collapsed ? "1" : "0"); } catch { /* ignore */ }
  syncRailToggle();
  setStatus(collapsed ? "Drawing rail collapsed — chart widened." : "Drawing rail expanded.");
});

// pressing Esc / right-click is handled per-pane; also clear pending anchors globally
function cancelPendingDrawings(): void {
  for (const p of state.panes) p.cancelPendingAnchor();
}

// track the chart the user last touched so Undo / Clear target it
viewport.addEventListener("pointerdown", (e) => {
  const paneEl = (e.target as HTMLElement).closest?.(".pane") as HTMLElement | null;
  if (!paneEl) return;
  const id = Number(paneEl.dataset.paneId);
  focusedPane = state.panes.find((p) => p.id === id) ?? null;
}, true);

// ─── watchlist panel ──────────────────────────────────────────────────
const watchlistBtn = document.getElementById("watchlistBtn") as HTMLButtonElement;
const watchlist = initWatchlist({
  button: watchlistBtn,
  onPick: (sym, ev) => {
    const wantsNew = !!ev && (ev.shiftKey || ev.altKey);
    // already open somewhere? focus it instead of duplicating
    const existing = state.panes.find((p) => p.symbol === sym);
    if (existing && !wantsNew) {
      focusedPane = existing;
      setStatus(`${sym} is already open in pane ${existing.id}`);
      watchlist.refreshOpenMarks();
      return;
    }
    if (wantsNew) {
      addPane(sym, state.lastTimeframe);
      setStatus(`Opened ${sym} in a new pane`);
      watchlist.refreshOpenMarks();
      return;
    }
    const target =
      focusedPane && state.panes.includes(focusedPane)
        ? focusedPane
        : state.panes[state.panes.length - 1] ?? null;
    if (target) {
      target.setSymbol(sym);
      if (target.wrap.style.display === "none") {
        // the focused pane was an overflow pane hidden by the layout — reveal it
        expandedHidden = true;
        try { localStorage.setItem(VIS_KEY, "1"); } catch { /* ignore */ }
        applyLayout(state.layoutKey);
        setStatus(`Pane ${target.id} → ${sym} (revealed hidden pane)`);
      } else {
        setStatus(`Pane ${target.id} → ${sym}`);
      }
    } else {
      addPane(sym, state.lastTimeframe);
      setStatus(`Opened ${sym}`);
    }
    watchlist.refreshOpenMarks();
  },
  getOpenSymbols: () => new Set(state.panes.map((p) => p.symbol)),
  onNotice: (msg) => setStatus(msg),
});

// ─── price alerts panel ───────────────────────────────────────────────
const alertsBtn = document.getElementById("alertsBtn") as HTMLButtonElement;
initAlertsPanel({ button: alertsBtn, onNotice: (msg) => setStatus(msg) });

// ─── boot ─────────────────────────────────────────────────────────────
const restored = restoreSession();
if (!restored) {
  state.layoutKey = "2×2";
  applyLayout("2×2");
  addPane("BTCUSDT", "1m");
  addPane("ETHUSDT", "1m");
  addPane("AAPL", "1D");
  addPane("AAPL", "1m"); // intraday slot defaults to tech — hidden if 1D chart chosen instead
  }
// Initialize pan toggle button state after session restore — always on
for (const p of state.panes) p.setPricePanMode(true);
panToggleBtn.classList.toggle("active", true);
panToggleBtn.textContent = "↕ Pan ✓";