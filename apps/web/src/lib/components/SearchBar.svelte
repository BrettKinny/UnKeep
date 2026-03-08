<script lang="ts">
  import { noteStore } from '$lib/noteStore.svelte';

  let focused = $state(false);
  let localQuery = $state(noteStore.searchQuery);
  let debounceTimer: ReturnType<typeof setTimeout>;

  function onInput(e: Event) {
    localQuery = (e.target as HTMLInputElement).value;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      noteStore.searchQuery = localQuery;
    }, 200);
  }
</script>

<div class="relative w-full sm:w-64 max-w-xl flex items-center min-w-0">
  <svg class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-on-surface-muted" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>
  <input
    type="text"
    placeholder="Search"
    value={localQuery}
    oninput={onInput}
    aria-label="Search notes"
    onfocus={() => focused = true}
    onfocusout={() => focused = false}
    class="w-full pl-10 pr-4 py-1 bg-transparent rounded-lg text-sm text-on-surface placeholder:text-on-surface-muted outline-none transition-colors border-b"
    class:border-primary={focused}
    class:border-transparent={!focused}
    class:bg-surface-dim={focused}
  />
</div>
