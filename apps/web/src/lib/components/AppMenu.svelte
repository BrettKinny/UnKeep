<script lang="ts">
  import { theme, type ThemeMode } from '$lib/theme.svelte';

  let {
    inTrash,
    exporting,
    onShowNotes,
    onShowTrash,
    onImport,
    onExport,
    onManageAccess,
  }: {
    inTrash: boolean;
    exporting: boolean;
    onShowNotes: () => void;
    onShowTrash: () => void;
    onImport: () => void;
    onExport: () => void;
    onManageAccess: () => void;
  } = $props();

  const themeModes: ThemeMode[] = ['system', 'light', 'dark'];
  let open = $state(false);

  function run(action: () => void) {
    open = false;
    action();
  }

  function handleWindowKeydown(event: KeyboardEvent) {
    if (open && event.key === 'Escape') {
      event.preventDefault();
      open = false;
    }
  }
</script>

<svelte:window onkeydown={handleWindowKeydown} />

<div class="relative z-50">
  <button
    type="button"
    class="grid h-10 w-10 place-items-center rounded-full text-on-surface-muted transition-colors hover:bg-surface-dim hover:text-on-surface focus-visible:outline-2 focus-visible:outline-primary"
    aria-label="Open UnKeep menu"
    aria-expanded={open}
    onclick={() => open = !open}
  >
    <svg class="h-5 w-5" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 6a2 2 0 110-4 2 2 0 010 4zm0 6a2 2 0 110-4 2 2 0 010 4zm0 6a2 2 0 110-4 2 2 0 010 4z"/></svg>
  </button>

  {#if open}
    <button
      type="button"
      class="fixed inset-0 z-[-1] cursor-default"
      aria-label="Close UnKeep menu"
      onclick={() => open = false}
    ></button>
    <div class="absolute right-0 mt-2 w-64 overflow-hidden rounded-xl border border-border bg-surface py-2 shadow-xl" role="menu">
      <button
        type="button"
        class="menu-item"
        role="menuitem"
        onclick={() => run(inTrash ? onShowNotes : onShowTrash)}
      >
        {#if inTrash}
          <svg class="menu-icon" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M9 18h6M10 22h4M8 14a7 7 0 118 0c-1 1-2 2-2 4h-4c0-2-1-3-2-4z"/></svg>
          Notes
        {:else}
          <svg class="menu-icon" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2m-9 0 1 15h8l1-15"/></svg>
          Trash
        {/if}
      </button>
      <button type="button" class="menu-item" role="menuitem" onclick={() => run(onImport)}>
        <svg class="menu-icon" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8-4-4m0 0L8 8m4-4v12"/></svg>
        Import notes…
      </button>
      <button type="button" class="menu-item" role="menuitem" disabled={exporting} onclick={() => run(onExport)}>
        <svg class="menu-icon" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M12 3v12m0 0 4-4m-4 4-4-4M5 17v2a2 2 0 002 2h10a2 2 0 002-2v-2"/></svg>
        {exporting ? 'Preparing export…' : 'Export vault'}
      </button>

      <div class="my-2 border-t border-border"></div>
      <div class="px-3 py-2">
        <p class="mb-2 text-xs font-medium text-on-surface-muted">Appearance</p>
        <div class="grid grid-cols-3 rounded-lg bg-surface-dim p-1" role="group" aria-label="Appearance">
          {#each themeModes as mode}
            <button
              type="button"
              class="rounded-md px-2 py-1.5 text-xs capitalize transition-colors"
              class:bg-surface={theme.mode === mode}
              class:text-on-surface={theme.mode === mode}
              class:shadow-sm={theme.mode === mode}
              class:text-on-surface-muted={theme.mode !== mode}
              aria-pressed={theme.mode === mode}
              onclick={() => theme.set(mode)}
            >{mode}</button>
          {/each}
        </div>
      </div>
      <div class="my-2 border-t border-border"></div>
      <button type="button" class="menu-item" role="menuitem" onclick={() => run(onManageAccess)}>
        <svg class="menu-icon" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M12 15a3 3 0 100-6 3 3 0 000 6z"/><path d="M19.4 15a1.7 1.7 0 00.34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0015 19.4a1.7 1.7 0 00-1 .6l-.05.08H10l-.05-.08a1.7 1.7 0 00-1-.6 1.7 1.7 0 00-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 004.6 15a1.7 1.7 0 00-.6-1L3.92 14v-4L4 9.95a1.7 1.7 0 00.6-1 1.7 1.7 0 00-.34-1.88L4.2 7l2.83-2.83.06.06A1.7 1.7 0 009 4.6a1.7 1.7 0 001-.6l.05-.08h4L14.1 4a1.7 1.7 0 001 .6 1.7 1.7 0 001.88-.34l.06-.06L19.87 7l-.06.06A1.7 1.7 0 0019.4 9c.08.4.3.75.6 1l.08.05v4L20 14.1a1.7 1.7 0 00-.6.9z"/></svg>
        Manage access…
      </button>
    </div>
  {/if}
</div>

<style>
  .menu-item {
    display: flex;
    width: 100%;
    align-items: center;
    gap: 0.75rem;
    padding: 0.625rem 0.875rem;
    text-align: left;
    font-size: 0.875rem;
    color: var(--color-on-surface);
  }

  .menu-item:hover {
    background: var(--color-surface-dim);
  }

  .menu-item:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: -2px;
  }

  .menu-item:disabled {
    cursor: wait;
    opacity: 0.55;
  }

  .menu-icon {
    width: 1.125rem;
    height: 1.125rem;
    flex: none;
    color: var(--color-on-surface-muted);
  }
</style>
