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
