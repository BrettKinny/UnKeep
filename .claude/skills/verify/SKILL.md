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

# Relay server serves the built PWA + sync API from one process. It only serves
# the PWA with NODE_ENV=production and an absolute UNKEEP_WEB_DIR. The tokens are
# fixed local test fixtures (>= 32 chars, different from each other; checked by
# apps/server/test/administrativeSecurity.test.mjs), so use a throwaway data dir.
DATA=$(mktemp -d)
NODE_ENV=production PORT=3111 UNKEEP_DATA_DIR="$DATA" \
UNKEEP_WEB_DIR="$PWD/apps/web/build" \
UNKEEP_SETUP_TOKEN=test-setup-token-12345678901234567890 \
UNKEEP_RECOVERY_TOKEN=test-recovery-token-1234567890123456 \
node apps/server/src/index.mjs
```

`/api/v1/status` returns `{"initialized":false}` on a fresh data dir. Unknown
paths fall back to `index.html` (SPA routing), so any client route works. Stop
the relay and `rm -rf "$DATA"` when done. See `docs/configuration.md`.

## Drive with Playwright

Use `playwright-core` from the repo's `node_modules` (Playwright 1.64.x). It
launches its own Chromium from `~/.cache/ms-playwright`; there is no
`/opt/pw-browsers`, and do not run `playwright install`. Use
`launchPersistentContext(dir, { acceptDownloads: true })` to keep the vault
between scripts.

First-device vault setup flow (required before notes can be saved):
1. On `/` click **Connect** (the "Sync server" input is prefilled with the origin)
2. Fill `getByLabel('Setup token')` with `UNKEEP_SETUP_TOKEN` → **Continue**
3. "Save your recovery kit" → click **Download recovery kit** (await the
   `download` event; it also ticks "I saved it somewhere safe") →
   **Initialize and open UnKeep**
4. The main app renders; note grid + toast are now observable.

Selectors rot quickly: `e2e/unkeep.spec.ts` is the reference for flows
(creating, editing, coloring, labelling, pinning, search, Trash, theme via the
app menu and localStorage `unkeep-theme`). Start there instead of guessing.
Basics: "Create a new note" opens a draft with "Note title"/"Note content"; a
card is the button "Edit note: <title>".

## Gotchas

- `pnpm check` fails until `@unkeep/client` is built (`tsc` emits its types).
- Vitest needs `pnpm exec svelte-kit sync` once before running in `apps/web`.
- `static/sw.js` precaches `manifest.json` cache-first — bump `CACHE_NAME`
  when changing anything in `static/`, or installed PWAs keep the stale copy.
