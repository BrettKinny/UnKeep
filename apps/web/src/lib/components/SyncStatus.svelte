<script lang="ts">
  import { noteStore } from '$lib/noteStore.svelte';

  const statusConfig = $derived.by(() => {
    switch (noteStore.syncStatus) {
      case 'synced': return { label: 'Synced', color: 'text-green-500' };
      case 'syncing': return { label: 'Syncing...', color: 'text-primary' };
      case 'offline': return { label: 'Offline', color: 'text-on-surface-muted' };
      case 'error': return { label: 'Sync error', color: 'text-danger' };
    }
  });
</script>

<span class="text-xs {statusConfig.color} flex items-center gap-1">
  {#if noteStore.syncStatus === 'syncing'}
    <svg class="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
  {:else if noteStore.syncStatus === 'synced'}
    <svg class="w-3 h-3" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg>
  {:else if noteStore.syncStatus === 'error'}
    <svg class="w-3 h-3" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clip-rule="evenodd"/></svg>
  {/if}
  {statusConfig.label}
  {#if noteStore.syncStatus === 'error'}
    <button
      class="ml-1 underline hover:text-on-surface cursor-pointer"
      onclick={() => noteStore.sync()}
      aria-label="Retry sync"
    >retry</button>
  {/if}
</span>
