<script lang="ts">
  import { fly } from 'svelte/transition';
  import { toastStore } from '$lib/toast.svelte';
</script>

<div
  class="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 flex-col gap-2"
  role="status"
  aria-live="polite"
  aria-atomic="false"
  aria-relevant="additions text"
>
  {#if toastStore.toasts.length > 0}
    {#each toastStore.toasts as toast (toast.id)}
      <div
        transition:fly={{ y: 20, duration: 200 }}
        class="bg-on-surface text-surface px-4 py-3 rounded-lg shadow-lg flex items-center gap-3 text-sm"
      >
        <span>{toast.message}</span>
        {#if toast.action}
          <button
            type="button"
            onclick={() => { toast.action?.fn(); toastStore.dismiss(toast.id); }}
            class="font-semibold text-primary uppercase text-xs hover:underline"
          >
            {toast.action.label}
          </button>
        {/if}
      </div>
    {/each}
  {/if}
</div>
