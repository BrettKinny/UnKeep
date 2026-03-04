<script lang="ts">
  import type { Note } from '@unkeep/core';
  import { noteStore } from '$lib/noteStore.svelte';
  import { toastStore } from '$lib/toast.svelte';
  import { encodeNote, getShareUrl } from '$lib/quickSend';
  import ColorPicker from './ColorPicker.svelte';
  import { nanoid } from 'nanoid';

  let { note, onClose }: { note: Note; onClose: () => void } = $props();

  let content = $state(note.content);
  let showColorPicker = $state(false);
  let showMarkdown = $state(false);

  const colorMap: Record<string, string> = {
    default: 'var(--color-note-default)',
    red: 'var(--color-note-red)',
    orange: 'var(--color-note-orange)',
    yellow: 'var(--color-note-yellow)',
    green: 'var(--color-note-green)',
    teal: 'var(--color-note-teal)',
    blue: 'var(--color-note-blue)',
    purple: 'var(--color-note-purple)',
    pink: 'var(--color-note-pink)',
    brown: 'var(--color-note-brown)',
    gray: 'var(--color-note-gray)',
  };

  function bgColor() {
    return colorMap[note.color ?? 'default'] ?? colorMap['default'];
  }

  function handleContentChange() {
    noteStore.updateNote(note.id, { content });
  }

  function handleCheckboxToggle(itemId: string, checked: boolean) {
    noteStore.updateChecklistItem(note.id, itemId, { checked });
  }

  function handleCheckboxText(itemId: string, text: string) {
    noteStore.updateChecklistItem(note.id, itemId, { text });
  }

  function handleAddCheckboxItem() {
    noteStore.addChecklistItem(note.id, '');
  }

  function handleRemoveCheckboxItem(itemId: string) {
    noteStore.removeChecklistItem(note.id, itemId);
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') onClose();
  }

  function handleCheckboxKeydown(e: KeyboardEvent, index: number) {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAddCheckboxItem();
      // Focus new input after render
      setTimeout(() => {
        const inputs = document.querySelectorAll<HTMLInputElement>('.checklist-input');
        inputs[inputs.length - 1]?.focus();
      }, 0);
    }
    if (e.key === 'Backspace' && note.checkboxes && note.checkboxes[index]?.text === '') {
      e.preventDefault();
      handleRemoveCheckboxItem(note.checkboxes[index].id);
    }
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
  onclick={onClose}
  onkeydown={handleKeydown}
>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="w-full max-w-lg rounded-lg shadow-xl max-h-[80vh] flex flex-col"
    style="background-color: {bgColor()}"
    onclick={(e) => e.stopPropagation()}
    onkeydown={() => {}}
  >
    <!-- Content -->
    <div class="flex-1 overflow-y-auto p-4">
      {#if note.checkboxes}
        <ul class="space-y-2">
          {#each note.checkboxes as item, i}
            <li class="flex items-center gap-2">
              <input
                type="checkbox"
                checked={item.checked}
                onchange={() => handleCheckboxToggle(item.id, !item.checked)}
                class="w-4 h-4 rounded"
              />
              <input
                type="text"
                value={item.text}
                oninput={(e) => handleCheckboxText(item.id, e.currentTarget.value)}
                onkeydown={(e) => handleCheckboxKeydown(e, i)}
                class="flex-1 bg-transparent text-on-surface outline-none checklist-input"
                placeholder="List item"
              />
              <button
                onclick={() => handleRemoveCheckboxItem(item.id)}
                class="p-1 text-on-surface-muted hover:text-danger opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M6 18L18 6M6 6l12 12"/></svg>
              </button>
            </li>
          {/each}
          <li>
            <button onclick={handleAddCheckboxItem} class="text-sm text-on-surface-muted hover:text-on-surface">
              + Add item
            </button>
          </li>
        </ul>
      {:else if showMarkdown}
        <div class="prose prose-sm max-w-none text-on-surface">
          <!-- Simple markdown rendering - just paragraphs and line breaks for now -->
          {#each content.split('\n\n') as para}
            <p>{para}</p>
          {/each}
        </div>
      {:else}
        <textarea
          bind:value={content}
          oninput={handleContentChange}
          onkeydown={handleKeydown}
          class="w-full min-h-[200px] bg-transparent text-on-surface resize-none outline-none"
          placeholder="Note content..."
        ></textarea>
      {/if}
    </div>

    <!-- Toolbar -->
    <div class="flex items-center gap-1 p-3 border-t border-border/30">
      <button
        onclick={() => noteStore.toggleChecklist(note.id)}
        class="p-1.5 rounded-full hover:bg-black/10 text-on-surface-muted hover:text-on-surface transition-colors"
        title={note.checkboxes ? 'Convert to text' : 'Convert to checklist'}
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"/></svg>
      </button>
      {#if !note.checkboxes}
        <button
          onclick={() => showMarkdown = !showMarkdown}
          class="p-1.5 rounded-full hover:bg-black/10 text-on-surface-muted hover:text-on-surface transition-colors"
          class:text-primary={showMarkdown}
          title={showMarkdown ? 'Edit' : 'Preview markdown'}
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>
        </button>
      {/if}
      <div class="relative">
        <button
          onclick={() => showColorPicker = !showColorPicker}
          class="p-1.5 rounded-full hover:bg-black/10 text-on-surface-muted hover:text-on-surface transition-colors"
          title="Change color"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01"/></svg>
        </button>
        {#if showColorPicker}
          <div class="absolute bottom-full left-0 mb-1 z-10">
            <ColorPicker
              selected={note.color ?? 'default'}
              onSelect={(color) => { noteStore.setColor(note.id, color); showColorPicker = false; }}
            />
          </div>
        {/if}
      </div>
      <button
        onclick={() => noteStore.togglePin(note.id)}
        class="p-1.5 rounded-full hover:bg-black/10 text-on-surface-muted hover:text-on-surface transition-colors"
        title={note.pinned ? 'Unpin' : 'Pin'}
      >
        <svg class="w-4 h-4" fill={note.pinned ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z"/></svg>
      </button>
      <button
        onclick={async () => {
          const text = note.checkboxes
            ? note.checkboxes.map(c => `${c.checked ? '☑' : '☐'} ${c.text}`).join('\n')
            : note.content;
          const encoded = await encodeNote(text);
          const url = getShareUrl(encoded);
          await navigator.clipboard.writeText(url);
          toastStore.show('Share link copied to clipboard');
        }}
        class="p-1.5 rounded-full hover:bg-black/10 text-on-surface-muted hover:text-on-surface transition-colors"
        title="Quick Send — copy share link"
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z"/></svg>
      </button>
      <span class="flex-1"></span>
      <button
        onclick={onClose}
        class="px-4 py-1.5 text-sm rounded-md hover:bg-black/10 text-on-surface transition-colors"
      >
        Close
      </button>
    </div>
  </div>
</div>
