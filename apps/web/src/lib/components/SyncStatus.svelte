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

  const quarantineLabel = $derived.by(() => {
    const count = noteStore.syncQuarantineCount;
    return count === 1
      ? '1 remote record is quarantined because it could not be safely decoded; other records are synced'
      : `${count} remote records are quarantined because they could not be safely decoded; other records are synced`;
  });
</script>

<span class="flex items-center gap-2">
  <span class="text-xs {statusConfig.color} flex items-center gap-1" title={statusConfig.label}>
    {#if noteStore.syncStatus === 'syncing'}
      <svg class="h-4 w-4 animate-spin sm:h-3 sm:w-3" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
    {:else if noteStore.syncStatus === 'synced'}
      <svg class="h-4 w-4 sm:h-3 sm:w-3" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg>
    {:else if noteStore.syncStatus === 'error'}
      <svg class="h-4 w-4 sm:h-3 sm:w-3" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clip-rule="evenodd"/></svg>
    {:else if noteStore.syncStatus === 'offline'}
      <svg class="h-4 w-4 sm:h-3 sm:w-3" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M3 3l18 18M9.36 5.36A7 7 0 0119.06 11a4.5 4.5 0 012.13 7.53M6.16 6.16A7 7 0 004.94 11 4.5 4.5 0 006.5 19.5h9.09"/></svg>
    {/if}
    <span class="sr-only sm:not-sr-only">{statusConfig.label}</span>
    {#if noteStore.syncStatus === 'error'}
      <button
        class="ml-1 underline hover:text-on-surface cursor-pointer"
        onclick={() => noteStore.sync()}
        aria-label="Retry sync"
      >retry</button>
    {/if}
  </span>
  {#if noteStore.syncQuarantineCount > 0}
    <span
      class="flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400"
      role="status"
      aria-live="polite"
      title={quarantineLabel}
    >
      <svg
        class="h-4 w-4 sm:h-3 sm:w-3"
        fill="currentColor"
        viewBox="0 0 20 20"
        aria-hidden="true"
      >
        <path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.72-1.36 3.486 0l6.518 11.59A2 2 0 0116.518 17H3.482a2 2 0 01-1.743-2.31l6.518-11.591zM11 14a1 1 0 11-2 0 1 1 0 012 0zm-1-7a1 1 0 00-1 1v3a1 1 0 102 0V8a1 1 0 00-1-1z" clip-rule="evenodd"/>
      </svg>
      <span aria-hidden="true">{noteStore.syncQuarantineCount} quarantined</span>
      <span class="sr-only">{quarantineLabel}</span>
    </span>
  {/if}
</span>
