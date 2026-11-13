# Repo guardrails for AI-assisted editing (applies to Copilot / Cursor / etc.)

Single-user, local, single-machine app. Everyone touching this repo assumes
the constraints below hold until the user (repo owner) explicitly revokes one.

## Hard rules

1. **Do not rewrite or "fix" the FX data path.** `src/feed.ts` →
   `updateFxBuckets`/`rebuildFxCandles`, `/api/ib/*` routes in `bin/serve.js`,
   and `bin/ib-bridge.js` are interdependent and were hand-verified
   in-session. Touch only with an explicit user request, and re-verify the FX
   chart after any change (open the FX pane; candles must render taller
   normal; flat wick-only 1m candles must expand via `expandFxFlats`;
   weekday alignment must hold for America/La_Paz UTC offsets).
2. **FX data is delay accepted.** The user wants the current IB ordinary
   delayed feed and has explicitly declined: (a) Binance EURUSDT as a real-time
   FX source, (b) ECB/currency-api substitutes, (c) changes to
   `IB_DATA_TYPE`. Do not re-propose any of these.
3. **`dist/` is gitignored and rebuilt locally** via `npm run build`. Never
   commit it. Never commit `node_modules/`. Never commit `.env*`, keys,
   tokens, credentials, or account numbers. Repo is private — keep it that
   way.
4. **Yahoo `/v7/finance/quote` returns 401 without auth; the app uses the
   spark endpoint.** Do not "upgrade" quote fetching to the plain quote
   endpoint.
5. **`bin/serve.js` and `bin/ib-bridge.js` require nothing external to
   start.** Do not add mandatory env files or new secrets; all config is
   optional env vars with safe loopback defaults (PORT=8080,
   IB_BRIDGE_PORT=8099, IB_HOST=127.0.0.1, IB_CLIENT_ID=32).
6. **FX / IB symbols chosen by the user are intentional.** `EURUSD=X`,
   `GBPJPY=X`, etc. stay. The list of subscribed symbols in `bin/ib-bridge.js`
   matches the user's subscriptions; don't trim or extend it unprompted.

## Build / run

- Fresh clone → `npm install` first.
- Day to day: `npm run serve` (serves app at http://localhost:8080) and
  `npm run ib` (IB bridge, only if TWS or IB Gateway is running on a local
  port). Then just open http://localhost:8080.
- Rebuild after TS edits: `node node_modules\typescript\bin\tsc` (a no-op /
  silent output means a passing build). **The browser needs Ctrl+Shift+R
  afterward** to pick up the new `dist/`.
- Type-check only: `npm run typecheck`.

## What is NOT true of this repo

- It is not deployable to Vercel/Pages as a working app. A static deploy
  would render the UI but no market data (the IB bridge only reaches
  127.0.0.1). Hosting restructure requires an explicit user decision and is
  out of scope for casual edits.
- There is no CI yet. Builds are local. Tests are the browser.

## Quick human verification checklist (after any edit)

1. `node node_modules\typescript\bin\tsc` — exits silently.
2. Refresh (Ctrl+Shift+R): no console errors, all panes render.
3. Open an FX pane: candles look normal; right edge markers sit on the plot
   edge (intentional, do not move them).
4. Candle countdown pill (`O HH:mm:ss · C HH:mm:ss · ⏳ mm:ss`) is present in
   the bottom-of-price axis only on full-size views.
5. git status: no `.env*`, `dist/`, or `node_modules/` staged.

## Recent fixes (applied to this repo)

### Modern TradingView-style toolbar icons (left drawing rail)

**Symptom:** the left drawing-tool rail used plain 2px cross/line glyphs that
read as dated next to TradingView's modern toolbar.

**Change:** replaced all `TOOL_DEFS` SVGs in `src/main.ts` with a cleaner set
in TradingView's public visual language — 24×24 grid, 1.75px rounded strokes,
center-dot anchors (crosshair, H/V lines, trend endpoints), true diagonal
parallel channel, volume-profile histogram, pencil-style brush, bell with
clapper, and Lucide-style eraser. Undo and Clear buttons switched from text
glyphs (`↺`, `🗑`) to matching SVG icons.

**Files changed:** `src/main.ts` (icons + undo/clear), `styles.css`
(`.tool-btn`: 40×32, 7px radius, muted-2 idle color, subtle hover, softer
blue active state).

**Note:** icons are recreated from TradingView's publicly visible UI style,
not copied from their proprietary bundles (repo guardrail on bundle code).

**Verify:** rebuild, Ctrl+Shift+R, confirm every rail icon renders crisply at
20px and the active tool shows the blue accent.

### Fixed-range volume profile — correctness overhaul

**Symptom:** the `volprofile` tool rendered but had real defects: it was
computed from the visible slice only (panning/zooming changed or hid it), the
histogram was anchored to the chart's right edge instead of the selection, the
value area used 70% of the *largest bucket* instead of 70% of total volume,
bars overlapped or left gaps depending on zoom, and the eraser couldn't hit it.

**Files changed:** `src/drawtools.ts`, `src/pane.ts`
- `volprofile` now reads full history via new optional `DrawCtx.allCandles`
  (populated from `this.candles` in `buildDrawCtx`) so the profile stays fixed
  when the range scrolls off-screen.
- Histogram anchored to the selected range's **left** edge, bars growing
  rightward (TradingView placement); width scales with the range.
- **TradingView up/down coloring:** each row is split into a green up-volume
  segment followed by a red down-volume segment (close ≥ open = up, else down),
  using the active theme's `palette().up`/`palette().down` so it matches the
  candles. Value-area rows draw at 0.9 alpha, tails at 0.45.
- Value area expands contiguously outward from the POC to 70% of total volume;
  POC/VAH/VAL lines only span the selection.
- Pixel-height rows from bucket size (no overlap/gaps); zero-height selection
  guarded; price labels use instrument-scaled decimals.
- `hitTest` gained a `volprofile` case (whole selection box) so the eraser
  works.

**Verify:** add `volprofile`, click twice over a range — green/red split bars
sit at the left edge of the selection growing right, POC/VAH/VAL label
correctly; pan away and it stays; eraser click inside the box deletes it.

### Fullscreen horizontal history slider

**Request:** in single-pane fullscreen, a horizontal slider at the bottom of
the chart (like the left rail's scrollbar) to slide through history.

**Files changed:** `src/pane.ts`, `styles.css`
- Every pane now builds a `.pane-hscroll` row with a native
  `<input type="range">` after the canvas. CSS hides it in grid view and shows
  it only under `.pane.fullscreen` (26px tall, `var(--pane-head)` background,
  thin `var(--border)` track, wide `var(--muted)` pill thumb that brightens on
  hover and turns accent-blue while dragging — matches the rail scrollbar).
- Slider maps left→older / right→newer: `max = bars - visibleBars`,
  `value = max - offsetBars`. Dragging sets `offsetBars` and zeroes
  `futureBars`; `syncHscroll()` runs on every `draw()` so mouse pans, wheel
  zoom and live bars keep the thumb current. Disabled when all bars fit.
- `fitCanvas()` now sizes the backing store from the canvas's own
  `getBoundingClientRect()` instead of `wrap.height - 26`; this keeps the
  drawing surface exact in fullscreen (borderless pane + slider row) with no
  2px vertical stretch.
- `toggleFullscreen()` explicitly refits so the canvas reserves/releases the
  slider row immediately; Esc path goes through the same method.

**Verify:** fullscreen a pane — slider appears at the bottom and the time axis
stays visible above it. Drag it: chart scrolls through history (screenshot
test: newest → 14h back). Mouse Shift+drag also moves the thumb; plain drag
stays vertical pan (`↕ Pan` default). Exit fullscreen — slider disappears.

