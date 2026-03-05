<script lang="ts">
  import { noteStore } from '$lib/noteStore.svelte';

  let expanded = $state(false);
  let content = $state('');
  let inputEl: HTMLTextAreaElement | undefined = $state();

  function handleFocus() {
    expanded = true;
  }

  function handleClose() {
    if (content.trim()) {
      noteStore.createNote(content.trim());
      content = '';
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

<div class="max-w-xl mx-auto mb-8">
  <div
    class="border border-border rounded-lg shadow-sm transition-all duration-150"
    class:shadow-md={expanded}
  >
    {#if expanded}
      <textarea
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
          data-keep-focus="true"
          onmousedown={(e) => e.preventDefault()}
          onclick={() => { handleClose(); inputEl?.blur(); }}
          class="px-4 py-1.5 text-sm text-on-surface-muted hover:text-on-surface rounded hover:bg-surface-dim transition-colors"
        >Close</button>
      </div>
    {:else}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        onclick={() => { expanded = true; setTimeout(() => inputEl?.focus(), 0); }}
        onkeydown={(e) => { if (e.key === 'Enter') { expanded = true; setTimeout(() => inputEl?.focus(), 0); }}}
        class="p-4 text-on-surface-muted cursor-text rounded-lg"
        role="button"
        tabindex="0"
      >
        Take a note...
      </div>
    {/if}
  </div>
</div>
