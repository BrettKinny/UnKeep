<script lang="ts">
  import { tick } from 'svelte';
  import type { NoteColor } from '@unkeep/core';
  import { noteStore } from '$lib/noteStore.svelte';
  import { colorMap } from '$lib/colors';
  import ColorPicker from './ColorPicker.svelte';
  import PinIcon from './PinIcon.svelte';

  let expanded = $state(false);
  let content = $state('');
  let title = $state('');
  let pinned = $state(false);
  let color = $state<NoteColor>('default');
  let showColorPicker = $state(false);
  let draftEl: HTMLDivElement | undefined = $state();
  let inputEl: HTMLTextAreaElement | undefined = $state();

  function handleClose() {
    if (content.trim() || title.trim()) {
      noteStore.createNote(content.trim(), title.trim(), { pinned, color });
      content = '';
      title = '';
    }
    pinned = false;
    color = 'default';
    showColorPicker = false;
    expanded = false;
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && showColorPicker) {
      showColorPicker = false;
      inputEl?.focus();
      return;
    }
    if (e.key === 'Escape' || (e.ctrlKey && e.key === 'Enter')) {
      handleClose();
      inputEl?.blur();
    }
  }
</script>

<div class="mx-auto mb-8 max-w-2xl sm:mb-12">
  <div
    class="relative rounded-lg border border-border bg-surface shadow-sm transition-all duration-150"
    class:shadow-md={expanded}
    style={expanded && color !== 'default' ? `background-color: ${colorMap[color]}` : undefined}
  >
    {#if expanded}
      <div
        bind:this={draftEl}
        onfocusout={(e) => {
          // Stay open while focus moves between the draft's own fields and controls.
          if (e.relatedTarget instanceof Node && draftEl?.contains(e.relatedTarget)) return;
          handleClose();
        }}
      >
        <label for="new-note-title" class="sr-only">Note title</label>
        <input
          id="new-note-title"
          type="text"
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
          onkeydown={handleKeydown}
          placeholder="Take a note..."
          rows="3"
          class="w-full p-4 pb-1 bg-transparent text-on-surface placeholder:text-on-surface-muted resize-none outline-none rounded-t-lg"
        ></textarea>
        <div class="flex items-center gap-1 px-2 pb-2">
          <button
            type="button"
            onmousedown={(e) => e.preventDefault()}
            onclick={() => pinned = !pinned}
            class="p-2 rounded-full hover:bg-black/10 dark:hover:bg-white/10 text-on-surface-muted hover:text-on-surface transition-colors"
            title={pinned ? 'Unpin' : 'Pin'}
            aria-label={pinned ? 'Unpin' : 'Pin'}
            aria-pressed={pinned}
          >
            <PinIcon filled={pinned} />
          </button>
          <button
            type="button"
            onmousedown={(e) => e.preventDefault()}
            onclick={() => showColorPicker = !showColorPicker}
            class="p-2 rounded-full hover:bg-black/10 dark:hover:bg-white/10 text-on-surface-muted hover:text-on-surface transition-colors"
            title="Change color"
            aria-label="Change color"
            aria-expanded={showColorPicker}
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01"/></svg>
          </button>
          <span class="flex-1"></span>
          <button
            type="button"
            onmousedown={(e) => e.preventDefault()}
            onclick={() => { handleClose(); inputEl?.blur(); }}
            class="px-4 py-1.5 text-sm text-on-surface-muted hover:text-on-surface rounded hover:bg-surface-dim transition-colors"
          >Close</button>
        </div>
        {#if showColorPicker}
          <!-- Keep focus in the draft so picking a colour does not close it. -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="absolute left-2 top-full mt-1 z-30"
            onmousedown={(e) => e.preventDefault()}
            onkeydown={handleKeydown}
          >
            <ColorPicker
              selected={color}
              onSelect={(next) => { color = next; showColorPicker = false; inputEl?.focus(); }}
            />
          </div>
        {/if}
      </div>
    {:else}
      <button
        type="button"
        aria-label="Create a new note"
        onclick={async () => {
          expanded = true;
          // Focus once the textarea mounts, before input events can reach the
          // title field; a timer could fire mid-typing and steal the text.
          await tick();
          inputEl?.focus();
        }}
        class="w-full cursor-text rounded-lg p-4 text-left text-on-surface-muted"
      >
        Take a note...
      </button>
    {/if}
  </div>
</div>
