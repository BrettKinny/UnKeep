# UnKeep - Project Status

## What is it
A privacy-first note-taking PWA (Google Keep clone). SvelteKit 5 + Tailwind v4, monorepo with `packages/core` (types, adapters) and `apps/web` (frontend).

## Running it
```bash
pnpm dev        # starts at http://localhost:5173
pnpm build      # static build to apps/web/build/
```

## Current state
Using LocalOnlyAdapter (IndexedDB, no remote sync). Setup wizard runs on first visit — pick "Local Only" to get going.

## Bug fixes applied (not yet committed)

### 1. Sync error on actions (FIXED)
- **File:** `apps/web/src/lib/noteStore.svelte.ts`
- **Problem:** Svelte 5 `$state` wraps objects in Proxies. IndexedDB's structured clone can't serialize Proxies.
- **Fix:** `$state.snapshot(note)` in `persistNote()` before passing to adapter. Also reset `syncStatus` to `'synced'` after successful saves.

### 2. Dark mode toggle (FIXED)
- **File:** `apps/web/src/lib/darkMode.svelte.ts`
- **Problem:** Removing `.dark` class wasn't enough — if OS prefers dark, `@media (prefers-color-scheme: dark) :root:not(.light)` still matched.
- **Fix:** `apply()` now also toggles `.light` class so the media query is blocked when user manually picks light.
- **CSS:** `apps/web/src/app.css` — dark variable overrides moved into `@layer theme` to stay in same cascade layer as `@theme` block.

### 3. Toolbar right-alignment (FIXED)
- **File:** `apps/web/src/routes/+page.svelte`
- **Fix:** Wrapped SyncStatus + Import + Archive + DarkMode in `<div class="ml-auto flex items-center gap-3">`.
- **Also:** `SearchBar.svelte` changed from `flex-1` to `w-64` — flex-1 was eating all space, preventing ml-auto from working.

### 4. Search bar styling (FIXED)
- **File:** `apps/web/src/lib/components/SearchBar.svelte`
- **Fix:** Removed visible background/border. Transparent by default, subtle bottom border + light bg on focus.

### 5. NoteInput close button (FIXED)
- **File:** `apps/web/src/lib/components/NoteInput.svelte`
- **Fix:** Added "Close" button at bottom-right when expanded. Uses `onmousedown preventDefault` to avoid stealing focus from textarea.

### 6. Ctrl+Enter to save note (FIXED)
- **File:** `apps/web/src/lib/components/NoteInput.svelte`
- **Fix:** `handleKeydown` checks `e.ctrlKey && e.key === 'Enter'` to save and close.

## What's next
- Verify all fixes work in browser (dark toggle, create/archive notes, toolbar layout)
- Commit the changes
- Anything else that comes up during testing

## Key files
| File | Purpose |
|------|---------|
| `apps/web/src/lib/noteStore.svelte.ts` | Central state — notes CRUD, IndexedDB persistence |
| `apps/web/src/lib/darkMode.svelte.ts` | Dark mode singleton, toggles classes on `<html>` |
| `apps/web/src/app.css` | Theme variables (light in `@theme`, dark in `@layer theme`) |
| `apps/web/src/routes/+page.svelte` | Main page — header, note grid, modals |
| `packages/core/src/adapters/local.ts` | LocalOnlyAdapter — IndexedDB read/write |

## Gotchas
- Svelte 5 `$state` arrays/objects are Proxies — always `$state.snapshot()` before passing to IndexedDB or structured clone
- Tailwind v4 `@theme` generates into `@layer theme` — dark overrides must be in same layer or unlayered with sufficient specificity
- OS dark mode preference + manual toggle need both `.dark` and `.light` classes to work correctly together
