<script lang="ts">
  import { noteStore } from '$lib/noteStore.svelte';

  let expanded = $state(false);
  let content = $state('');
  let title = $state('');
  let inputEl: HTMLTextAreaElement | undefined = $state();

  function handleClose() {
    if (content.trim() || title.trim()) {
      noteStore.createNote(content.trim(), title.trim());
      content = '';
      title = '';
    }
    expanded = false;
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' || (e.ctrlKey && e.key === 'Enter')) {
      handleClose();
      inputEl?.blur();
    }
  }
</script>

<div class="mx-auto mb-8 max-w-2xl sm:mb-12">
  <div
    class="rounded-lg border border-border bg-surface shadow-sm transition-all duration-150"
    class:shadow-md={expanded}
  >
    {#if expanded}
      <label for="new-note-title" class="sr-only">Note title</label>
      <input
        id="new-note-title"
        type="text"
        data-keep-focus="true"
        bind:value={title}
        placeholder="Title"
        onkeydown={handleKeydown}
        class="w-full px-4 pt-3 bg-transparent text-on-surface font-medium placeholder:text-on-surface-muted outline-none rounded-t-lg"
      />
      <label for="new-note-content" class="sr-only">Note content</label>
      <textarea
        id="new-note-content"
        bind:this={inputEl}
        bind:value={content}
        onfocusout={(e) => {
          if (e.relatedTarget instanceof HTMLElement && e.relatedTarget.dataset.keepFocus) return;
          handleClose();
        }}
        onkeydown={handleKeydown}
        placeholder="Take a note..."
        rows="3"
        class="w-full p-4 pb-1 bg-transparent text-on-surface placeholder:text-on-surface-muted resize-none outline-none rounded-t-lg"
      ></textarea>
      <div class="flex justify-end px-2 pb-2">
        <button
          type="button"
          data-keep-focus="true"
          onmousedown={(e) => e.preventDefault()}
          onclick={() => { handleClose(); inputEl?.blur(); }}
          class="px-4 py-1.5 text-sm text-on-surface-muted hover:text-on-surface rounded hover:bg-surface-dim transition-colors"
        >Close</button>
      </div>
    {:else}
      <button
        type="button"
        aria-label="Create a new note"
        onclick={() => { expanded = true; setTimeout(() => inputEl?.focus(), 0); }}
        class="w-full cursor-text rounded-lg p-4 text-left text-on-surface-muted"
      >
        Take a note...
      </button>
    {/if}
  </div>
</div>
