# Trump Goggles Splash Page

Landing page for the [Trump Goggles](https://github.com/phrazzld/trump-goggles) browser extension.

## What is Trump Goggles?

A browser extension that translates text to Trumpisms as you browse:
- "ISIS" → "Evil Losers"
- "Hillary Clinton" → "Crooked Hillary"
- "The Media" → "Fake News"

## Development

This is a static site. No build step required.

```bash
# Open directly in browser
open index.html

# Or use any static server
python3 -m http.server 3000
npx serve .

# Liveness, retirement, and config contracts
node tools/verify-retirement.js

# Browser bootstrap (vm sandbox; proves disabled is a no-op)
node tools/verify-browser.js

# Verify Worker routing locally
node tools/verify-worker.mjs

# Run the full local CI gate
node tools/ci.js

# Run the Worker locally (assets + api routes; needs wrangler 4.135+)
# Tip: if dev reload-loops, add `--persist-to /tmp/wrangler-state`; the
# local state churn under .wrangler/ can trip the file watcher when the
# assets directory is the repo root.
wrangler dev --env staging
```

## Structure

```
├── index.html      # Single page
├── styles/
│   └── main.css    # All styles
├── scripts/
│   ├── sentry.js   # Browser Sentry bootstrap (config-injected)
│   └── main.js     # Scroll animations (~40 lines)
├── api/
│   ├── health.js
│   ├── sentry-config.js
│   └── canary/api/v1/errors.js
├── src/
│   └── worker.mjs  # Cloudflare Worker entry
├── tools/
│   ├── ci.js
│   ├── verify-retirement.js
│   ├── verify-browser.js
│   ├── verify-server.js
│   └── verify-worker.mjs
├── favicon.ico
└── README.md
```

## Observability

The Cloudflare Worker `trump-goggles-splash` is attached and ready
(`wrangler deploy --env production`); `trumpgoggles.mistystep.io` already
serves from it. `trumpgoggles.com` and `www.trumpgoggles.com` attach at the
registrar nameserver flip; until that flip completes, `www.trumpgoggles.com`
still reaches the DigitalOcean Caddy origin. Static assets come from the
assets layer; `src/worker.mjs` serves the same routes as the
dependency-free Node sidecar in `server.js`, so the contract holds on both
runtimes:

- `GET|HEAD /api/health` — site liveness only. HTTP 200 is never proof of
  error delivery.
- `GET|HEAD /api/sentry-config` — browser-monitoring config, injectable at
  deploy time.
- `any method /api/canary/api/v1/errors` — HTTP 410 tombstone. The old
  Canary relay is retired; the route never reads, stores, or forwards a
  request body.

Browser error collection is intentionally unavailable until a Sentry DSN is
provided at deploy time. The page loads the official `@sentry/browser`
bundle (pinned version) only when the config endpoint reports
`enabled: true`; errors then travel from the SDK straight to Sentry ingest.
The app owns no relay and stores nothing.

Both runtimes read the same environment names:

- `SENTRY_DSN` — public client-side DSN for the site's Sentry project.
  Unset means monitoring is off; no DSN is committed to this repository.
- `SENTRY_ENVIRONMENT` — `staging` or `production`
- `SENTRY_RELEASE` — optional release identifier
- `NODE_ENV` — fallback environment name

## Links

- **Chrome Web Store:** [Install Trump Goggles](https://chromewebstore.google.com/detail/trump-goggles/jffbimfdmgbfannficjejaffmnggoigd)
- **Extension Source:** [github.com/phrazzld/trump-goggles](https://github.com/phrazzld/trump-goggles)

## License

MIT