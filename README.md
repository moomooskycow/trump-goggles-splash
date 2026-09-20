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

# Verify Canary health and relay behavior
node tools/verify-canary.js

# Verify Worker routing locally
node tools/verify-worker.mjs

# Run the full local CI gate
node tools/ci.js

# Run the Worker locally (assets + api routes)
wrangler dev --env staging

# After production deploy, verify Canary ingest and readback
CANARY_READ_API_KEY=... node tools/smoke-canary-production.js
```

## Structure

```
├── index.html      # Single page
├── styles/
│   └── main.css    # All styles
├── scripts/
│   ├── canary.js   # Browser error observer
│   └── main.js     # Scroll animations (~40 lines)
├── api/
│   ├── health.js
│   └── canary/api/v1/errors.js
├── src/
│   └── worker.mjs  # Cloudflare Worker entry
├── tools/
│   ├── ci.js
│   ├── verify-canary.js
│   ├── verify-worker.mjs
│   └── smoke-canary-production.js
├── favicon.ico
└── README.md
```

## Observability

Production serves from the Cloudflare Worker `trump-goggles-splash`
(`wrangler deploy --env production`). Static assets come from the assets
layer; `src/worker.mjs` serves the same two routes as the dependency-free
Node sidecar in `server.js`, so the contract holds on both runtimes:

- `GET|HEAD /api/health`
- `POST /api/canary/api/v1/errors`

The handlers in `api/` are provider-neutral and shared by both runtimes.

Both runtimes read the same environment names:

- `CANARY_API_KEY` - service-bound ingest key for `trump-goggles-splash`
- `CANARY_ENDPOINT` - defaults to `https://canary.mistystep.io`
- `CANARY_SERVICE_NAME` - defaults to `trump-goggles-splash`
- `NEXT_PUBLIC_SITE_URL` - canonical origin, `https://www.trumpgoggles.com`

`/api/health` is a liveness/config check and returns `503` in production if
Canary is not configured. Use `tools/smoke-canary-production.js` after deploy
to prove end-to-end Canary ingest.

## Links

- **Chrome Web Store:** [Install Trump Goggles](https://chromewebstore.google.com/detail/trump-goggles/jffbimfdmgbfannficjejaffmnggoigd)
- **Extension Source:** [github.com/phrazzld/trump-goggles](https://github.com/phrazzld/trump-goggles)

## License

MIT
