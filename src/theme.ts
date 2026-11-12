// ────────────────────────────────────────────────────────────────────
// theme.ts — chart theme (DOM via CSS variables, canvas via palette).
// Themes:
//   midnight  — default dark navy (original look)
//   black     — OLED-friendly pure black
//   daylight  — light theme
// Persisted in localStorage; panes must redraw when it changes.
// ────────────────────────────────────────────────────────────────────

export type ThemeId = "midnight" | "black" | "daylight";

export interface ThemeDef { id: ThemeId; label: string }

export const THEMES: ThemeDef[] = [
  { id: "midnight", label: "Midnight" },
  { id: "black", label: "Black (OLED)" },
  { id: "daylight", label: "Daylight" },
];

export interface CanvasPalette {
  panel: string;
  grid: string;
  axisText: string;
  axisTextDim: string;
  dimText: string;
  mutedText: string;
  up: string;
  down: string;
  upFill: string;
  downFill: string;
  volUp: string;
  volDown: string;
  legendBg: string;
  legendText: string;
  crosshair: string;
  priceTagBg: string;
  priceTagText: string;
  oscGuide: string;
  alert: string;
  sma10: string;
  sma30: string;
  ema12: string;
  rsi: string;
  macd: string;
  macdSignal: string;
  macdHistUp: string;
  macdHistDown: string;
}

const MIDNIGHT: CanvasPalette = {
  panel: "#0c1018",
  grid: "rgba(255,255,255,0.055)",
  axisText: "rgba(255,255,255,0.5)",
  axisTextDim: "rgba(255,255,255,0.32)",
  dimText: "rgba(255,255,255,0.55)",
  mutedText: "rgba(255,255,255,0.30)",
  up: "#26a69a",
  down: "#ef5350",
  upFill: "rgba(38,166,154,0.9)",
  downFill: "rgba(239,83,80,0.9)",
  volUp: "rgba(38,166,154,0.4)",
  volDown: "rgba(239,83,80,0.4)",
  legendBg: "rgba(0,0,0,0.7)",
  legendText: "#ffffff",
  crosshair: "rgba(255,255,255,0.45)",
  priceTagBg: "rgba(41,98,255,0.95)",
  priceTagText: "#ffffff",
  oscGuide: "rgba(255,255,255,0.10)",
  alert: "#ffb300",
  sma10: "#ffd200",
  sma30: "#3b7bff",
  ema12: "#b57bff",
  rsi: "#ffb86c",
  macd: "#ff7a18",
  macdSignal: "#4dc3ff",
  macdHistUp: "rgba(38,166,154,0.6)",
  macdHistDown: "rgba(239,83,80,0.6)",
};

const BLACK: CanvasPalette = {
  ...MIDNIGHT,
  panel: "#000000",
  grid: "rgba(255,255,255,0.07)",
  axisText: "rgba(255,255,255,0.55)",
  axisTextDim: "rgba(255,255,255,0.35)",
  dimText: "rgba(255,255,255,0.6)",
  legendBg: "rgba(0,0,0,0.85)",
  priceTagBg: "rgba(41,98,255,1)",
};

const DAYLIGHT: CanvasPalette = {
  panel: "#ffffff",
  grid: "rgba(0,0,0,0.075)",
  axisText: "rgba(0,0,0,0.55)",
  axisTextDim: "rgba(0,0,0,0.38)",
  dimText: "rgba(0,0,0,0.55)",
  mutedText: "rgba(0,0,0,0.32)",
  up: "#0f8a6a",
  down: "#d93a3a",
  upFill: "rgba(15,138,106,0.85)",
  downFill: "rgba(217,58,58,0.85)",
  volUp: "rgba(15,138,106,0.35)",
  volDown: "rgba(217,58,58,0.35)",
  legendBg: "rgba(255,255,255,0.94)",
  legendText: "#10141c",
  crosshair: "rgba(0,0,0,0.35)",
  priceTagBg: "#2962ff",
  priceTagText: "#ffffff",
  oscGuide: "rgba(0,0,0,0.12)",
  alert: "#b26b00",
  sma10: "#b8860b",
  sma30: "#2962ff",
  ema12: "#7c3aed",
  rsi: "#c2410c",
  macd: "#ea580c",
  macdSignal: "#0284c7",
  macdHistUp: "rgba(15,138,106,0.55)",
  macdHistDown: "rgba(217,58,58,0.55)",
};

const PALETTES: Record<ThemeId, CanvasPalette> = {
  midnight: MIDNIGHT,
  black: BLACK,
  daylight: DAYLIGHT,
};

const KEY = "multi-chart:theme:v1";
let current: ThemeId = "midnight";

function isThemeId(v: unknown): v is ThemeId {
  return v === "midnight" || v === "black" || v === "daylight";
}

export function themeId(): ThemeId {
  return current;
}

export function palette(): CanvasPalette {
  return PALETTES[current];
}

export function setTheme(id: ThemeId): void {
  current = id;
  document.body.dataset.theme = id;
  try { localStorage.setItem(KEY, id); } catch { /* private mode */ }
}

/** Call once at boot; applies the saved theme (defaults to midnight). */
export function initTheme(): void {
  let saved: ThemeId = "midnight";
  try {
    const raw = localStorage.getItem(KEY);
    if (isThemeId(raw)) saved = raw;
  } catch { /* ignore */ }
  setTheme(saved);
}
