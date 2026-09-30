<script lang="ts">
  import { onMount } from 'svelte';
  import { SHORTCUT_GROUPS, shortcutsFor } from '$lib/shortcuts';

  let { onClose }: { onClose: () => void } = $props();

  let dialogEl: HTMLDivElement | undefined = $state();

  onMount(() => {
    const previouslyFocused = document.activeElement;
    dialogEl?.focus();
    return () => {
      if (previouslyFocused instanceof HTMLElement && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    };
  });

  function handleBackdropClick(event: MouseEvent) {
    if (event.target === event.currentTarget) onClose();
  }

  function handleDialogKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab' || !dialogEl) return;

    // Only the close button is focusable, so keep Tab from leaving the dialog.
    const focusable = [...dialogEl.querySelectorAll<HTMLElement>('button:not([disabled])')];
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) {
      event.preventDefault();
      dialogEl.focus();
      return;
    }

    const active = document.activeElement;
    const focusStartsAtDialog = active === dialogEl || !dialogEl.contains(active);
    if (event.shiftKey && (active === first || focusStartsAtDialog)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || focusStartsAtDialog)) {
      event.preventDefault();
      first.focus();
    }
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
  onclick={handleBackdropClick}
  onkeydown={handleDialogKeydown}
>
  <div
    bind:this={dialogEl}
    class="flex max-h-[85dvh] w-full max-w-lg flex-col rounded-2xl border border-border bg-surface shadow-2xl"
    role="dialog"
    aria-modal="true"
    aria-labelledby="shortcuts-dialog-title"
    tabindex="-1"
  >
    <div class="flex items-center justify-between border-b border-border px-4 py-3">
      <h2 id="shortcuts-dialog-title" class="text-base font-semibold text-on-surface">Keyboard shortcuts</h2>
      <button
        type="button"
        onclick={onClose}
        class="rounded-full p-2 text-on-surface-muted transition-colors hover:bg-surface-dim hover:text-on-surface"
        aria-label="Close keyboard shortcuts"
      >
        <svg class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
    </div>

    <div class="flex-1 overflow-y-auto px-4 py-3">
      {#each SHORTCUT_GROUPS as group (group.context)}
        <section class="mb-5 last:mb-0">
          <h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-on-surface-muted">{group.title}</h3>
          <dl class="space-y-1">
            {#each shortcutsFor(group.context) as shortcut (shortcut.action)}
              <div class="flex items-center justify-between gap-4 rounded px-1 py-1.5">
                <dt class="text-sm text-on-surface">{shortcut.description}</dt>
                <dd class="flex shrink-0 items-center gap-1">
                  {#each shortcut.display as key, index (key)}
                    {#if index > 0}
                      <span class="text-xs text-on-surface-muted">or</span>
                    {/if}
                    <kbd class="rounded border border-border bg-surface-dim px-2 py-0.5 font-sans text-xs text-on-surface-muted">{key}</kbd>
                  {/each}
                </dd>
              </div>
            {/each}
          </dl>
        </section>
      {/each}
      <p class="border-t border-border pt-3 text-xs leading-relaxed text-on-surface-muted">
        Shortcuts are inactive while you are typing in a note or the search box.
        In Trash, pinning and deleting from the keyboard are turned off.
      </p>
    </div>
  </div>
</div>
