<script lang="ts">
  import { onMount } from 'svelte';
  import { decodeNote } from '$lib/quickSend';
  import { noteStore } from '$lib/noteStore.svelte';
  import { toastStore } from '$lib/toast.svelte';
  import Toast from '$lib/components/Toast.svelte';

  let content = $state('');
  let error = $state('');
  let saved = $state(false);

  onMount(async () => {
    const hash = window.location.hash.slice(1);
    if (!hash) {
      error = 'No note data found in the URL.';
      return;
    }
    try {
      content = await decodeNote(hash);
    } catch (e) {
      error = `Failed to decode note: ${e}`;
    }
  });

  function handleCopy() {
    navigator.clipboard.writeText(content);
    toastStore.show('Copied to clipboard');
  }

  async function handleSave() {
    noteStore.createNote(content);
    saved = true;
    toastStore.show('Note saved!');
  }
</script>

<main class="min-h-screen bg-surface flex items-center justify-center p-4">
  <div class="w-full max-w-lg">
    <div class="text-center mb-6">
      <img src="/icon.svg" alt="UnKeep" class="w-12 h-12 mx-auto mb-2" />
      <h1 class="text-2xl font-bold text-on-surface">UnKeep</h1>
      <p class="text-on-surface-muted text-sm mt-1">Received note</p>
    </div>

    {#if error}
      <div class="bg-danger/10 border border-danger/30 text-danger rounded-lg p-4 text-center">
        {error}
      </div>
    {:else if content}
      <div class="bg-surface-dim rounded-lg p-4 border border-border">
        <pre class="whitespace-pre-wrap text-on-surface text-sm font-mono">{content}</pre>
      </div>

      <div class="flex gap-3 mt-4">
        <button
          onclick={handleCopy}
          class="flex-1 py-2.5 border border-border rounded-lg text-on-surface hover:bg-surface-dim transition-colors"
        >
          Copy to clipboard
        </button>
        {#if !saved}
          <button
            onclick={handleSave}
            class="flex-1 py-2.5 bg-primary text-on-primary rounded-lg font-medium hover:bg-primary-dim transition-colors"
          >
            Save to UnKeep
          </button>
        {:else}
          <div class="flex-1 py-2.5 text-center text-green-500 font-medium">
            Saved!
          </div>
        {/if}
      </div>

      <p class="text-xs text-on-surface-muted text-center mt-4">
        This note was shared via URL. The content never left your browser — it was encoded entirely in the URL fragment.
      </p>
    {:else}
      <div class="text-center py-8">
        <svg class="w-8 h-8 mx-auto animate-spin text-primary" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
        <p class="mt-3 text-on-surface-muted">Decoding note...</p>
      </div>
    {/if}
  </div>
</main>

<Toast />
