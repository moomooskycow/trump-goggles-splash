# CLAUDE.md

Static splash page for the Trump Goggles browser extension.

## Project

- **Type:** Static HTML/CSS/JS (no build step)
- **Theme:** Retro Americana (red, blue, cream, gold)
- **Font:** Playfair Display (Google Fonts)

## Structure

```
├── index.html      # All sections
├── styles/main.css # Theme + animations
├── scripts/sentry.js # Browser Sentry bootstrap (config-injected, no-op when disabled)
├── scripts/main.js # Scroll observer
├── api/health.js # Liveness endpoint (sidecar + Worker)
├── api/sentry-config.js # Injectable browser-monitoring config
├── api/canary/api/v1/errors.js # 410 tombstone for the retired relay
├── src/worker.mjs # Cloudflare Worker entry (assets + api routes)
├── tools/ci.js # Local CI gate used by GitHub Actions
├── tools/verify-retirement.js # Liveness + tombstone + config contract checks
├── tools/verify-browser.js # vm-sandbox check of scripts/sentry.js
├── tools/verify-worker.mjs # Worker route verification
└── favicon.ico
```

## Development

```bash
# Open in browser
open index.html

# Or any static server
python3 -m http.server 3000

# Contract checks
node tools/verify-retirement.js
node tools/verify-browser.js

# Verify Worker routing locally
node tools/verify-worker.mjs

# Run the full local CI gate
node tools/ci.js

# Run the Worker locally (assets + api routes)
wrangler dev --env staging
```

## URLs

- Chrome Store: https://chromewebstore.google.com/detail/trump-goggles/jffbimfdmgbfannficjejaffmnggoigd
- GitHub: https://github.com/phrazzld/trump-goggles
- Production: https://www.trumpgoggles.com
- Staging: https://trump-goggles-splash-staging.misty-step.workers.dev

## Observability notes

- `GET /api/health` is liveness only; it never proves error delivery.
- The retired legacy relay answers 410 for every method and never reads or
  forwards request bodies. Kept until a separate removal decision.
- Browser error collection runs through the official Sentry browser SDK and
  is enabled by a deploy-provided `SENTRY_DSN` (see README). Never commit a
  DSN and never invent one.