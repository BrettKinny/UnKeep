<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { relaySessionStore } from '$lib/clientStorage';
  import { parseSharePayload, stashPendingShare, type SharePayload } from '$lib/shareTarget';

  let payload = $state<SharePayload | null>(null);
  let loaded = $state(false);
  let busy = $state(false);
  let error = $state<string | null>(null);

  onMount(() => {
    payload = parseSharePayload(window.location.search, window.location.hash);
    // Strip shared content immediately. It stays in memory until the user
    // confirms which local vault should receive it.
    history.replaceState(null, '', resolve('/share'));
    loaded = true;
  });

  async function confirmShare() {
    if (!payload || busy) return;
    busy = true;
    error = null;
    try {
      const session = await relaySessionStore.load();
      stashPendingShare(payload, session?.instanceId ?? null);
      await goto(resolve('/'), { replaceState: true });
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'The shared note could not be prepared';
    } finally {
      busy = false;
    }
  }

  function cancelShare() {
    void goto(resolve('/'), { replaceState: true });
  }
</script>

<main class="min-h-screen bg-surface flex items-center justify-center p-4">
  <div class="w-full max-w-lg text-center">
    <img src="/icon.svg" alt="UnKeep" class="w-12 h-12 mx-auto mb-2" />
    <h1 class="text-2xl font-bold text-on-surface">UnKeep</h1>

    {#if !loaded}
      <div class="py-8">
        <svg class="w-8 h-8 mx-auto animate-spin text-primary" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
        <p class="mt-3 text-on-surface-muted">Reading shared content…</p>
      </div>
    {:else if !payload}
      <p class="mt-4 text-on-surface-muted">Nothing was shared. This page saves content shared to UnKeep from other apps.</p>
      <a href={resolve('/')} class="mt-4 inline-block py-2.5 px-6 bg-primary text-on-primary rounded-lg font-medium hover:bg-primary-dim transition-colors">
        Open UnKeep
      </a>
    {:else}
      <div class="mt-5 rounded-xl border border-border bg-surface-dim p-4 text-left">
        {#if payload.title}
          <h2 class="font-semibold text-on-surface">{payload.title}</h2>
        {/if}
        <pre class="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap break-words text-sm text-on-surface">{payload.text}</pre>
      </div>
      <p class="mt-3 text-sm text-on-surface-muted">
        Review this content before adding it to your current vault.
      </p>
      {#if error}
        <p class="mt-3 text-sm text-danger" role="alert">{error}</p>
      {/if}
      <div class="mt-5 flex gap-3">
        <button
          class="flex-1 rounded-lg border border-border px-4 py-2.5 text-on-surface hover:bg-surface-dim"
          disabled={busy}
          onclick={cancelShare}
        >
          Cancel
        </button>
        <button
          class="flex-1 rounded-lg bg-primary px-4 py-2.5 font-medium text-on-primary hover:bg-primary-dim disabled:opacity-50"
          disabled={busy}
          onclick={() => void confirmShare()}
        >
          {busy ? 'Preparing…' : 'Save to UnKeep'}
        </button>
      </div>
    {/if}
  </div>
</main>
