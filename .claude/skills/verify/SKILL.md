---
name: verify
description: Build, launch, and drive the UnKeep PWA + relay server to verify web app changes in a real browser.
---

# Verifying UnKeep changes

## Build and launch

```bash
pnpm install
pnpm --filter @unkeep/core build && pnpm --filter @unkeep/client build   # workspace deps first
pnpm --filter @unkeep/web build                                          # outputs apps/web/build/

# Relay server serves the built PWA + sync API from one process:
cd apps/server
UNKEEP_SETUP_TOKEN=test-setup-token-12345678901234567890 \
UNKEEP_RECOVERY_TOKEN=test-recovery-token-1234567890123456 \
UNKEEP_DATA_DIR=/tmp/unkeep-data PORT=3111 node src/index.mjs
```

`/api/v1/status` returns `{"initialized":false}` on a fresh data dir. Unknown
paths fall back to `index.html` (SPA routing), so any client route works.

## Drive with Playwright

`playwright-core` + `executablePath: '/opt/pw-browsers/chromium'` (pre-installed
Chromium; do not run `playwright install`).

First-device vault setup flow (required before notes can be saved):
1. On `/` → "Sync server" input is prefilled with the origin → click **Connect**
2. Setup view → fill the `input[type="password"]` with the `UNKEEP_SETUP_TOKEN` → **Create vault**
3. Recovery kit view → click **Download recovery kit** (use `acceptDownloads: true`
   and await the `download` event) → **Open UnKeep**
4. Main app renders; note grid + toast are now observable.

## Gotchas

- `pnpm check` fails until `@unkeep/client` is built (`tsc` emits its types).
- Vitest needs `pnpm exec svelte-kit sync` once before running in `apps/web`.
- `static/sw.js` precaches `manifest.json` cache-first — bump `CACHE_NAME`
  when changing anything in `static/`, or installed PWAs keep the stale copy.
