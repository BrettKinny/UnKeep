<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { parseSharePayload, stashPendingShare } from '$lib/shareTarget';

  let empty = $state(false);

  onMount(() => {
    const payload = parseSharePayload(window.location.search, window.location.hash);
    if (!payload) {
      empty = true;
      return;
    }
    stashPendingShare(payload);
    // Strip the shared content from the address bar before leaving the page.
    history.replaceState(null, '', '/share');
    goto(resolve('/'), { replaceState: true });
  });
</script>

<main class="min-h-screen bg-surface flex items-center justify-center p-4">
  <div class="w-full max-w-lg text-center">
    <img src="/icon.svg" alt="UnKeep" class="w-12 h-12 mx-auto mb-2" />
    <h1 class="text-2xl font-bold text-on-surface">UnKeep</h1>

    {#if empty}
      <p class="mt-4 text-on-surface-muted">Nothing was shared. This page saves content shared to UnKeep from other apps.</p>
      <a href={resolve('/')} class="mt-4 inline-block py-2.5 px-6 bg-primary text-on-primary rounded-lg font-medium hover:bg-primary-dim transition-colors">
        Open UnKeep
      </a>
    {:else}
      <div class="py-8">
        <svg class="w-8 h-8 mx-auto animate-spin text-primary" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
        <p class="mt-3 text-on-surface-muted">Saving shared note...</p>
      </div>
    {/if}
  </div>
</main>
