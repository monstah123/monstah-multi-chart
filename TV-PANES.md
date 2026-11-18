# TradingView panes (optional chart engine)

This app keeps its original native canvas engine as the default. A pane can now
use the official TradingView widget instead, per pane — you do not have to choose
one engine for the whole workspace.

## Use

- **+ TV** in the top bar adds a TradingView pane using the symbol currently in
  the symbol box.
- **TV** in a native pane's header switches that pane to TradingView in place.
- **Native** in a TV pane's header switches it back. Symbol, timeframe, layout
  slot and fullscreen state are preserved.
- Layouts, saved setups, session restore and Export/Import all record
  `kind: "native" | "tv"`.

## Data

- TV panes stream from TradingView's own feed. FX and crypto are real-time;
  US equities are ~15 minutes delayed unless the viewer's TradingView plan
  upgrades the feed. The app's `/api/quotes` watchlist is unchanged and keeps
  using Binance + IB bridge + Yahoo spark.
- Your IC Markets account is **not** connected to the widget. `ICMARKETS:` /
  `FX:` symbols on TradingView are TradingView's redistributed broker feed.
  Feeding your own IC Markets account into the native engine (MT5 Python bridge
  or cTrader Open API) is a separate, later step.

## Attribution

The TradingView logo in the widget's lower-left corner is required by
TradingView's embed terms and cannot be removed or covered.

## Rollback

The pre-feature state is tagged `pre-tv-pane`.

```powershell
cd chart
git reset --hard pre-tv-pane
npm run build
```

A plain-file snapshot also exists at
`..\_backups\chart-pre-tv-2026-11-18\` (outside this repo).
