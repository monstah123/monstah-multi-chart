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

### Fullscreen badge shows stale timeframe after switching TF

**Symptom:** in fullscreen mode the symbol shows in blue (the `fs-badge`
overlay), but changing the chart timeframe (e.g. `1M` → `5M`) leaves the
badge showing the old timeframe.

**Root cause:** `ChartPane.updateFsBadge()` only ran from `toggleFullscreen()`
and `setSymbol()`. The two timeframe-change paths updated `this.timeframe`
and called `load()` but never refreshed the badge, so it froze at the TF
active when fullscreen was entered.

**Files changed:** `src/pane.ts`, `src/main.ts`
- `src/pane.ts` per-pane dropdown `change` → added `this.updateFsBadge()`
  after `void this.load()`.
- `src/pane.ts` → exposed public `refreshFsBadge()` wrapper around the
  private `updateFsBadge()`.
- `src/main.ts` timeframe button handler → added `p.refreshFsBadge()`
  after `void p.load()`.

**Verify:** fullscreen a pane, then click a different TF button and the
per-pane dropdown — the badge must track the new timeframe.

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
