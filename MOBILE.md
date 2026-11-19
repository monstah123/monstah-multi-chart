# Phone / iPad access (Tailscale)

The app has no login. Only expose it on a trusted network — Tailscale is the
intended one. Do **not** enable Tailscale Funnel for it.

## 1. Start the server in LAN mode

```powershell
cd chart
npm run serve:lan
```

`serve:lan` is `node bin/serve.js --lan`, which binds `0.0.0.0` instead of
`127.0.0.1`. Plain `npm run serve` stays loopback-only.

Find the Tailscale IPv4:

```powershell
tailscale ip -4
```

## 2. Allow the port through Windows Firewall (once, as Administrator)

```powershell
New-NetFirewallRule -DisplayName "MONSTAH Multi-Chart 8080" `
  -Direction Inbound -Action Allow -Protocol TCP `
  -LocalPort 8080 -LocalAddress <tailscale-ipv4> -Profile Any
```

Remove it later with:

```powershell
Remove-NetFirewallRule -DisplayName "MONSTAH Multi-Chart 8080"
```

> The firewall rule is bound to the Tailscale address only, so the port is not
> opened on Wi-Fi / public interfaces.

## 3. Open it on the phone / iPad

With Tailscale connected and signed into the same account:

```
http://<tailscale-ipv4>:8080
```

Use `http://`, not `https://`.

## 4. Install as a home-screen app

The page ships `manifest.webmanifest` + `icons/`, so it installs standalone
(no Safari address bar) with a proper icon.

- **iPhone / iPad (Safari):** Share → Add to Home Screen
- **Android (Chrome):** ⋮ → Add to Home screen

If you already added a shortcut before the icons existed, **delete it and add it
again** — iOS caches the old icon.

## Notes

- The desktop must be awake and the server running. After a reboot,
  `npm run serve:lan` again.
- Native panes need the local proxy (`/api/quotes`, `/api/yahoo-history`), so the
  app only works while this machine is serving it.
- TV panes stream from TradingView over the internet, so their data still works
  as long as the phone has connectivity.
- Tap **⤢** on a pane for full-screen; the 2×2 grid is tight on a phone.
- Anyone on your tailnet can open the app. There is no authentication.
