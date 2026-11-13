// ────────────────────────────────────────────────────────────────────────────
// drawtools.ts — drawing layer shared by every ChartPane.
// Shapes are anchored to (timeMs, price) pairs, exactly like TradingView:
// they survive panning, zooming and timeframe changes.
// Persisted per symbol+timeframe key in localStorage.
// ────────────────────────────────────────────────────────────────────────────

import { palette } from "./theme.js";

export type ToolId =
  | "cross"      // default cursor (no drawing)
  | "dot"
  | "arrow"
  | "trend"
  | "ray"
  | "hline"
  | "vline"
  | "measure"
  | "rect"
  | "fib"
  | "fibext"     // 3-point fibonacci extension
  | "channel"    // 3-point parallel channel
  | "pitchfork"  // 3-point Andrews pitchfork
  | "volprofile" // 2-point fixed range volume profile
  | "position"   // 3-point long/short position tool
  | "brush"      // freehand
  | "text"
  | "alert"      // not a shape: click creates a price alert
  | "eraser";

export interface Anchor { t: number; p: number }

export interface Shape {
  id: string;
  kind: ToolId;
  a: Anchor;      // first anchor
  b?: Anchor;     // second anchor (2-point shapes)
  pts?: Anchor[]; // all anchors for multi-point shapes (brush/channel/pitchfork/fibext/position)
  text?: string;
  color: string;
  width: number;
  /** creation time (ms) — lets undo pick the newest drawing vs price alert */
  createdAt?: number;
}

export type StrokeStyle = { color: string; width: number };
export const DEFAULT_STYLE: StrokeStyle = { color: "#2962ff", width: 2 };

export const PALETTE = ["#2962ff", "#26a69a", "#f7a600", "#ef5350", "#ffffff", "#ab47bc"];
export const WIDTHS = [1, 2, 3, 4];

/** How many chart clicks a tool needs (single-click tools default to 1). */
export const CLICK_COUNT: Partial<Record<ToolId, number>> = {
  arrow: 2, trend: 2, ray: 2, measure: 2, rect: 2, fib: 2,
  channel: 3, pitchfork: 3, fibext: 3, position: 3,
  volprofile: 2,
};

/** Tools drawn by press-drag-release instead of clicks. */
export const DRAG_TOOLS: ReadonlySet<ToolId> = new Set<ToolId>(["brush"]);

const LS_KEY = (sym: string, tf: string) => `mc-draw:${sym}:${tf}`;

/** Pips per unit for common symbols — adjust as needed */
function getPipSize(symbol: string): number {
  const s = symbol.toUpperCase();
  if (/^[A-Z]{6}=X$/.test(s)) return 0.0001;           // FX majors (EURUSD=X etc.)
  if (s.includes("JPY") && s.includes("=X")) return 0.01; // JPY pairs
  if (s.endsWith("USDT") || s.endsWith("BTC") || s.endsWith("ETH")) return 0.01; // crypto
  if (s.startsWith("^") || s.includes("=F")) return 0.25; // futures/indices
  return 0.01; // stocks default
}

/** Estimate bars between two timestamps for a given timeframe */
function getBarsBetween(t1: number, t2: number, timeframe: string): number {
  const ms: Record<string, number> = {
    "1m": 60_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000,
    "1h": 3_600_000, "4h": 14_400_000, "1D": 86_400_000, "1W": 604_800_000, "1M": 2_592_000_000
  };
  const tfMs = ms[timeframe] ?? 60_000;
  return Math.max(0, Math.round(Math.abs(t2 - t1) / tfMs));
}

export function newShapeId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export function listShapes(symbol: string, timeframe: string): Shape[] {
  try {
    const raw = localStorage.getItem(LS_KEY(symbol, timeframe));
    if (!raw) return [];
    const arr = JSON.parse(raw) as Shape[];
    return Array.isArray(arr) ? arr.filter((s) => s && typeof s.kind === "string" && s.a && typeof s.a.t === "number") : [];
  } catch { return []; }
}

export function saveShapes(symbol: string, timeframe: string, shapes: Shape[]): void {
  try {
    if (shapes.length === 0) localStorage.removeItem(LS_KEY(symbol, timeframe));
    else localStorage.setItem(LS_KEY(symbol, timeframe), JSON.stringify(shapes));
  } catch { /* quota / sandbox */ }
}

export function clearShapes(symbol: string, timeframe: string): void {
  try { localStorage.removeItem(LS_KEY(symbol, timeframe)); } catch { /* ignore */ }
}

// ─── geometry: hit test in pixel space against a render context ────────
export interface DrawCtx {
  ctx: CanvasRenderingContext2D;
  left: number; right: number; top: number; priceH: number; bottom: number;
  lo: number; hi: number;
  slice: { t: number; o: number; h: number; l: number; c: number; v: number }[];
  /** full candle history — lets range tools (volprofile) stay fixed when panning */
  allCandles?: { t: number; o: number; h: number; l: number; c: number; v: number }[];
  timeToX: (t: number) => number;
  priceToY: (p: number) => number;
  timeframe: string;
  symbol: string;
}

const TOL = 7;

function distToSeg(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** Pixel points for a shape's anchors */
function pixelPts(shape: Shape, d: DrawCtx): [number, number][] {
  const src = shape.pts && shape.pts.length > 0 ? shape.pts : [shape.a, ...(shape.b ? [shape.b] : [])];
  return src.map((p) => [d.timeToX(p.t), d.priceToY(p.p)]);
}

export function hitTest(p: { x: number; y: number }, shape: Shape, d: DrawCtx): boolean {
  const pts = pixelPts(shape, d);
  const ax = pts[0]?.[0] ?? 0, ay = pts[0]?.[1] ?? 0;
  switch (shape.kind) {
    case "dot": return Math.hypot(p.x - ax, p.y - ay) <= TOL + 3;
    case "hline": return Math.abs(p.y - ay) <= TOL;
    case "vline": return Math.abs(p.x - ax) <= TOL;
    case "text": return Math.abs(p.x - ax) <= 80 && Math.abs(p.y - ay) <= 16;
    case "brush": {
      for (let i = 1; i < pts.length; i++) {
        if (distToSeg(p.x, p.y, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) <= TOL) return true;
      }
      return false;
    }
    case "channel": {
      if (pts.length < 3) return false;
      const [a, b, c] = pts;
      const slope = b[0] !== a[0] ? (b[1] - a[1]) / (b[0] - a[0]) : 0;
      const cOff = c[1] - (a[1] + slope * (c[0] - a[0]));
      return (
        Math.abs(p.y - (a[1] + slope * (p.x - a[0]))) <= TOL ||
        Math.abs(p.y - (a[1] + slope * (p.x - a[0]) + cOff)) <= TOL
      );
    }
    case "pitchfork": {
      if (pts.length < 3) return false;
      const lines = pitchforkLines(pts);
      return lines.some(([x1, y1, x2, y2]) => distToSeg(p.x, p.y, x1, y1, x2, y2) <= TOL);
    }
    case "fibext": {
      if (pts.length < 3) return false;
      const levels = fibExtLevels(pts);
      return levels.some(([, y]) => Math.abs(p.y - y) <= TOL);
    }
    case "position": {
      if (pts.length < 3) return false;
      const [entry, stop, target] = pts;
      const x1 = Math.min(entry[0], target[0], stop[0]) - 4, x2 = pts.length >= 4 ? pts[3][0] : d.right;
      const inBox = (yA: number, yB: number) => {
        const ys = [yA, yB].sort((m, n) => m - n);
        return p.x >= x1 && p.x <= x2 + TOL && p.y >= ys[0] - TOL && p.y <= ys[1] + TOL;
      };
      return inBox(entry[1], target[1]) || inBox(entry[1], stop[1]);
    }
    case "volprofile": {
      // whole selection box is the hit target so the eraser/picker works
      if (pts.length < 2) return false;
      const x1 = Math.min(pts[0][0], pts[1][0]), x2 = Math.max(pts[0][0], pts[1][0]);
      const y1 = Math.min(pts[0][1], pts[1][1]), y2 = Math.max(pts[0][1], pts[1][1]);
      return p.x >= x1 - TOL && p.x <= x2 + TOL && p.y >= y1 - TOL && p.y <= y2 + TOL;
    }
    default: {
      if (pts.length < 2) return false;
      return distToSeg(p.x, p.y, pts[0][0], pts[0][1], pts[1][0], pts[1][1]) <= TOL;
    }
  }
}

// ─── geometry helpers (pixel space) ──────────────────────────────────
function pitchforkLines(pts: [number, number][]): [number, number, number, number][] {
  const [p0, p1, p2] = pts;
  const mid: [number, number] = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
  const dx = mid[0] - p0[0], dy = mid[1] - p0[1];
  const slope = dx !== 0 ? dy / dx : 0;
  const through = (x: number, y: number): [number, number, number, number] => {
    // line through (x,y) with the median slope, extended beyond the right edge
    const farX = 10000;
    return [x, y, x + farX, y + slope * farX];
  };
  return [through(p0[0], p0[1]), through(p1[0], p1[1]), through(p2[0], p2[1])];
}

/** Fibonacci extension levels: [ratio, priceY] pairs in pixel space */
function fibExtLevels(pts: [number, number][]): [number, number][] {
  const [, b, c] = pts; // a-b = leg, c = base
  const [a] = pts;
  const levels = [0, 0.618, 1, 1.618, 2.618];
  const leg = a[1] - b[1]; // price axis is inverted in pixels
  return levels.map((lv) => [lv, c[1] + leg * lv]);
}

const fmtPct = (v: number): string => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`;
const fmtNum = (n: number): string => `${n >= 0 ? "+" : ""}${Math.round(n * 100) / 100}`;
/** price with decimals that scale to the instrument (0.00001 coins vs 100k BTC) */
const fmtPriceLabel = (v: number): string => {
  if (!Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a >= 1000) return v.toFixed(2);
  if (a >= 10) return v.toFixed(3);
  if (a >= 1) return v.toFixed(4);
  if (a >= 0.01) return v.toFixed(5);
  return v.toFixed(6);
};

// ─── renderer ─────────────────────────────────────────────────────────
export function drawShape(shape: Shape, d: DrawCtx): void {
  const { ctx } = d;
  const pts = pixelPts(shape, d);
  const ax = pts[0]?.[0] ?? 0, ay = pts[0]?.[1] ?? 0;
  const bx = pts[1]?.[0] ?? ax, by = pts[1]?.[1] ?? ay;
  ctx.save();
  ctx.strokeStyle = shape.color;
  ctx.fillStyle = shape.color;
  ctx.lineWidth = shape.width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  switch (shape.kind) {
    case "dot":
      ctx.beginPath(); ctx.arc(ax, ay, Math.max(3, shape.width + 1.5), 0, Math.PI * 2); ctx.fill();
      break;
    case "hline":
      ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.moveTo(d.left, ay); ctx.lineTo(d.right, ay); ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = "10px sans-serif";
      ctx.textAlign = "left"; ctx.textBaseline = "bottom";
      ctx.fillText(shape.a.p.toFixed(2), d.right - 56, ay - 2);
      break;
    case "vline":
      ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.moveTo(ax, d.top); ctx.lineTo(ax, d.bottom); ctx.stroke();
      ctx.setLineDash([]);
      break;
    case "arrow": {
      if (pts.length < 2) break;
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
      const ang = Math.atan2(by - ay, bx - ax);
      const head = 8 + shape.width;
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(bx - head * Math.cos(ang - 0.42), by - head * Math.sin(ang - 0.42));
      ctx.lineTo(bx - head * Math.cos(ang + 0.42), by - head * Math.sin(ang + 0.42));
      ctx.closePath(); ctx.fill();
      break;
    }
    case "trend": case "ray": {
      if (pts.length < 2) break;
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
      if (shape.kind === "ray" && bx !== ax) {
        const slope = (by - ay) / (bx - ax);
        ctx.beginPath();
        ctx.moveTo(bx, by);
        ctx.lineTo(d.right + 200, by + slope * (d.right + 200 - bx));
        ctx.stroke();
      }
      break;
    }
    case "measure": {
      if (pts.length < 2) break;
      ctx.globalAlpha = 0.18;
      ctx.fillRect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
      ctx.globalAlpha = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
      ctx.setLineDash([]);
      const dp = shape.b ? shape.b.p - shape.a.p : 0;
      const pct = dp / (shape.a.p || 1);
      const bars = d.timeframe && shape.b ? getBarsBetween(shape.a.t, shape.b.t, d.timeframe) : 0;
      const pipSize = d.symbol ? getPipSize(d.symbol) : 0.01;
      const pips = dp / pipSize;
      const label = `${fmtNum(dp)}  (${fmtPct(pct)})  ${pips.toFixed(1)} pips  ${bars} bars`;
      ctx.font = "bold 11px sans-serif";
      const tw = ctx.measureText(label).width + 14;
      const lx = Math.min(Math.max((ax + bx) / 2 - tw / 2, d.left), d.right - tw);
      const ly = Math.min(ay, by) - 22;
      ctx.fillStyle = "rgba(0,0,0,0.72)";
      ctx.fillRect(lx, Math.max(d.top, ly), tw, 16);
      ctx.fillStyle = dp >= 0 ? "#26a69a" : "#ef5350";
      ctx.textAlign = "left"; ctx.textBaseline = "middle";
      ctx.fillText(label, lx + 7, Math.max(d.top, ly) + 8);
      break;
    }
    case "rect": {
      if (pts.length < 2) break;
      ctx.globalAlpha = 0.13;
      ctx.fillRect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
      ctx.globalAlpha = 1;
      ctx.beginPath(); ctx.rect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay)); ctx.stroke();
      break;
    }
    case "volprofile": {
      if (pts.length < 2) break;
      const b = shape.b;
      if (!b) break;
      const loP = Math.min(shape.a.p, b.p);
      const hiP = Math.max(shape.a.p, b.p);
      if (!(hiP > loP)) break; // zero-height selection — nothing to bucket
      const startTime = Math.min(shape.a.t, b.t);
      const endTime = Math.max(shape.a.t, b.t);

      // Fixed-range profile must use the whole history for that window, not
      // just the bars currently on screen — otherwise panning/zooming changes
      // the histogram and it stops being "fixed".
      const source = d.allCandles && d.allCandles.length ? d.allCandles : d.slice;
      const rangeCandles = source.filter(
        (c) => c.t >= startTime && c.t <= endTime && Number.isFinite(c.v) && c.v > 0,
      );
      if (rangeCandles.length === 0) break;

      // price buckets — one row per bucket, filled by each candle's H-L span.
      // Volume is split into up/down the way TradingView does it: a bar whose
      // close is at or above its open counts as up volume, otherwise down.
      const bucketCount = 30;
      const bucketSize = (hiP - loP) / bucketCount;
      const volUp = new Array<number>(bucketCount).fill(0);
      const volDown = new Array<number>(bucketCount).fill(0);
      for (const c of rangeCandles) {
        const cLo = Math.max(Math.min(c.l, c.h), loP);
        const cHi = Math.min(Math.max(c.l, c.h), hiP);
        if (cHi < cLo) continue;
        let s = Math.floor((cLo - loP) / bucketSize);
        let e = Math.floor((cHi - loP) / bucketSize);
        s = Math.max(0, Math.min(bucketCount - 1, s));
        e = Math.max(0, Math.min(bucketCount - 1, e));
        const share = c.v / (e - s + 1);
        const side = c.c >= c.o ? volUp : volDown;
        for (let i = s; i <= e; i++) side[i] += share;
      }

      const vols = new Array<number>(bucketCount);
      let totalVol = 0, maxVol = 0, pocIdx = -1;
      for (let i = 0; i < bucketCount; i++) {
        vols[i] = volUp[i] + volDown[i];
        totalVol += vols[i];
        if (vols[i] > maxVol) { maxVol = vols[i]; pocIdx = i; }
      }
      if (totalVol <= 0 || pocIdx < 0) break;
      const priceOf = (i: number): number => loP + (i + 0.5) * bucketSize;
      const pocPrice = priceOf(pocIdx);

      // 70% value area — expand contiguously outward from the POC
      let vaLo = pocIdx, vaHi = pocIdx, vaVol = vols[pocIdx];
      const targetVol = totalVol * 0.7;
      while (vaVol < targetVol && (vaLo > 0 || vaHi < bucketCount - 1)) {
        const below = vaLo > 0 ? vols[vaLo - 1] : -1;
        const above = vaHi < bucketCount - 1 ? vols[vaHi + 1] : -1;
        if (above >= below) { vaHi++; vaVol += vols[vaHi]; }
        else { vaLo--; vaVol += vols[vaLo]; }
      }
      const val = loP + vaLo * bucketSize;
      const vah = loP + (vaHi + 1) * bucketSize;

      // anchor the histogram to the left edge of the selected time range,
      // bars growing rightward — TradingView's fixed-range placement
      const startX = d.timeToX(startTime);
      const endX = d.timeToX(endTime);
      const x1 = Math.max(d.left, Math.min(startX, endX));
      const x2 = Math.min(d.right, Math.max(startX, endX));
      if (x2 <= x1) break;
      const rangeW = x2 - x1;
      const profileWidth = Math.min(160, Math.max(44, rangeW * 0.55));
      const profileLeft = x1;
      const rowPx = Math.max(1, Math.abs(d.priceToY(loP) - d.priceToY(loP + bucketSize)));

      // histogram — TradingView's up/down split: each row is a green segment
      // (up volume) followed by a red segment (down volume), scaled to the
      // busiest row. Value-area rows are vivid, tails are dimmed.
      const upColor = palette().up;
      const downColor = palette().down;
      for (let i = 0; i < bucketCount; i++) {
        const rowVol = vols[i];
        if (rowVol <= 0) continue;
        const y = d.priceToY(priceOf(i));
        const rowW = (rowVol / maxVol) * profileWidth;
        const upW = (volUp[i] / rowVol) * rowW;
        const downW = rowW - upW;
        const inVa = i >= vaLo && i <= vaHi;
        ctx.globalAlpha = inVa ? 0.9 : 0.45;
        if (upW > 0.25) {
          ctx.fillStyle = upColor;
          ctx.fillRect(profileLeft, y - rowPx / 2, upW, rowPx + 0.5);
        }
        if (downW > 0.25) {
          ctx.fillStyle = downColor;
          ctx.fillRect(profileLeft + upW, y - rowPx / 2, downW, rowPx + 0.5);
        }
      }
      ctx.globalAlpha = 1;

      // selection box edges
      ctx.strokeStyle = "rgba(41, 98, 255, 0.45)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(x1, d.priceToY(hiP)); ctx.lineTo(x2, d.priceToY(hiP));
      ctx.moveTo(x1, d.priceToY(loP)); ctx.lineTo(x2, d.priceToY(loP));
      ctx.moveTo(x1, d.priceToY(hiP)); ctx.lineTo(x1, d.priceToY(loP));
      ctx.moveTo(x2, d.priceToY(hiP)); ctx.lineTo(x2, d.priceToY(loP));
      ctx.stroke();
      ctx.setLineDash([]);

      // POC + value-area levels across the range
      ctx.strokeStyle = "#ffd200";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 5]);
      const pocY = d.priceToY(pocPrice);
      ctx.beginPath(); ctx.moveTo(x1, pocY); ctx.lineTo(x2, pocY); ctx.stroke();
      ctx.setLineDash([]);

      ctx.strokeStyle = "rgba(255, 210, 0, 0.55)";
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 6]);
      for (const price of [vah, val]) {
        const y = d.priceToY(price);
        ctx.beginPath(); ctx.moveTo(x1, y); ctx.lineTo(x2, y); ctx.stroke();
      }
      ctx.setLineDash([]);

      // labels
      ctx.font = "bold 10px sans-serif";
      ctx.textAlign = "right";
      ctx.textBaseline = "bottom";
      ctx.fillStyle = "#ffd200";
      ctx.fillText(`POC ${fmtPriceLabel(pocPrice)}`, x2 - 4, pocY - 3);
      ctx.fillStyle = "rgba(255, 210, 0, 0.85)";
      ctx.textBaseline = "middle";
      ctx.fillText(`VAH ${fmtPriceLabel(vah)}`, x2 - 4, d.priceToY(vah) - 7);
      ctx.fillText(`VAL ${fmtPriceLabel(val)}`, x2 - 4, d.priceToY(val) + 7);

      break;
    }
    case "fib": {
      if (pts.length < 2) break;
      const levels = [0, 0.236, 0.382, 0.5, 0.618, 0.764, 1];
      ctx.font = "9px sans-serif";
      ctx.lineWidth = 1;
      for (const lv of levels) {
        const y = by - (by - ay) * lv;
        ctx.globalAlpha = lv === 0 || lv === 1 ? 0.9 : 0.45;
        ctx.setLineDash(lv === 0 || lv === 1 ? [] : [3, 3]);
        ctx.beginPath(); ctx.moveTo(d.left, y); ctx.lineTo(d.right, y); ctx.stroke();
        ctx.globalAlpha = 1; ctx.setLineDash([]);
        ctx.textAlign = "right"; ctx.textBaseline = "middle";
        const price = shape.a.p + ((shape.b?.p ?? shape.a.p) - shape.a.p) * lv;
        ctx.fillText(`${lv.toFixed(3)} — ${price.toFixed(2)}`, d.right - 4, y - 6);
      }
      break;
    }
    case "brush": {
      if (pts.length < 2) break;
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.stroke();
      break;
    }
    case "channel": {
      if (pts.length < 3) break;
      const [a, b, c] = pts;
      const slope = b[0] !== a[0] ? (b[1] - a[1]) / (b[0] - a[0]) : 0;
      const cOff = c[1] - (a[1] + slope * (c[0] - a[0]));
      const yAt = (x: number, off: number) => a[1] + slope * (x - a[0]) + off;
      ctx.globalAlpha = 0.10;
      ctx.beginPath();
      ctx.moveTo(d.left, yAt(d.left, 0));
      ctx.lineTo(d.right, yAt(d.right, 0));
      ctx.lineTo(d.right, yAt(d.right, cOff));
      ctx.lineTo(d.left, yAt(d.left, cOff));
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.moveTo(d.left, yAt(d.left, 0)); ctx.lineTo(d.right, yAt(d.right, 0));
      ctx.moveTo(d.left, yAt(d.left, cOff)); ctx.lineTo(d.right, yAt(d.right, cOff));
      ctx.stroke();
      break;
    }
    case "pitchfork": {
      if (pts.length < 3) break;
      const lines = pitchforkLines(pts);
      ctx.globalAlpha = 0.55;
      ctx.beginPath();
      ctx.moveTo(lines[1][0], lines[1][1]); ctx.lineTo(lines[1][2], lines[1][3]);
      ctx.moveTo(lines[2][0], lines[2][1]); ctx.lineTo(lines[2][2], lines[2][3]);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.moveTo(lines[0][0], lines[0][1]); ctx.lineTo(lines[0][2], lines[0][3]);
      ctx.stroke();
      break;
    }
    case "fibext": {
      if (pts.length < 3) break;
      const levels = fibExtLevels(pts);
      ctx.font = "9px sans-serif";
      ctx.lineWidth = 1;
      for (const [lv, y] of levels) {
        ctx.globalAlpha = lv === 0 ? 0.9 : 0.55;
        ctx.setLineDash(lv === 0 ? [] : [4, 3]);
        ctx.beginPath(); ctx.moveTo(d.left, y); ctx.lineTo(d.right, y); ctx.stroke();
        ctx.globalAlpha = 1; ctx.setLineDash([]);
        ctx.textAlign = "right"; ctx.textBaseline = "middle";
        ctx.fillText(`${lv.toFixed(3)}`, d.right - 4, y - 6);
      }
      break;
    }
    case "position": {
      if (pts.length < 3) break;
      const [entry, stop, target] = pts;
      const x1 = Math.min(entry[0], target[0], stop[0]);
      // optional 4th anchor sets the box's right edge in time (stretchable like TradingView)
      const x2 = pts.length >= 4 ? pts[3][0] : d.right;
      const box = (yA: number, yB: number, color: string, alpha: number) => {
        ctx.globalAlpha = alpha;
        ctx.fillStyle = color;
        ctx.fillRect(x1, Math.min(yA, yB), x2 - x1, Math.abs(yB - yA));
        ctx.globalAlpha = 1;
        ctx.fillStyle = shape.color;
      };
      box(entry[1], target[1], "#26a69a", 0.14);
      box(entry[1], stop[1], "#ef5350", 0.14);
      // left-edge grab bar + boundary dots — hint that the box drags sideways
      // and the SL / entry / TP levels stretch like TradingView
      const yTop = Math.min(entry[1], stop[1], target[1]);
      const yBot = Math.max(entry[1], stop[1], target[1]);
      ctx.globalAlpha = 0.75;
      ctx.strokeStyle = shape.color;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x1, yTop); ctx.lineTo(x1, yBot); ctx.stroke();
      // right-edge bar + mid dot — grab to stretch the position in time
      ctx.beginPath(); ctx.moveTo(x2, yTop); ctx.lineTo(x2, yBot); ctx.stroke();
      for (const y of [target[1], entry[1], stop[1]]) {
        ctx.globalAlpha = 0.95;
        ctx.fillStyle = "#ffffff";
        ctx.beginPath(); ctx.arc(x1 + 3, y, 2.6, 0, Math.PI * 2); ctx.fill();
      }
      ctx.fillStyle = "#ffffff";
      ctx.beginPath(); ctx.arc(x2 - 2, (yTop + yBot) / 2, 3, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
      // entry line
      ctx.setLineDash([5, 3]);
      ctx.strokeStyle = shape.color;
      ctx.beginPath(); ctx.moveTo(x1, entry[1]); ctx.lineTo(x2, entry[1]); ctx.stroke();
      ctx.setLineDash([]);
      // reward / risk labels
      const entryP = shape.pts?.[0]?.p ?? shape.a.p;
      const stopP = shape.pts?.[1]?.p ?? entryP;
      const targetP = shape.pts?.[2]?.p ?? entryP;
      const risk = Math.abs(entryP - stopP);
      const reward = Math.abs(targetP - entryP);
      const rr = risk > 0 ? reward / risk : 0;
      ctx.font = "bold 10px sans-serif";
      ctx.textAlign = "left"; ctx.textBaseline = "middle";
      ctx.fillStyle = "#26a69a";
      ctx.fillText(`TP ${targetP.toFixed(2)}  R:R ${rr.toFixed(2)}`, x1 + 6, Math.min(entry[1], target[1]) + 10);
      ctx.fillStyle = "#ef5350";
      ctx.fillText(`SL ${stopP.toFixed(2)}`, x1 + 6, Math.max(entry[1], stop[1]) - 10);
      break;
    }
    case "text":
      ctx.font = `${Math.max(11, 10 + shape.width)}px sans-serif`;
      ctx.fillStyle = shape.color;
      ctx.textAlign = "left"; ctx.textBaseline = "middle";
      ctx.fillText(shape.text ?? "", ax + 4, ay);
      break;
  }
  ctx.restore();
}
