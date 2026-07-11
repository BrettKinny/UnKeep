<script lang="ts">
  import type { Note } from '@unkeep/core';
  import { noteStore } from '$lib/noteStore.svelte';
  import { toastStore } from '$lib/toast.svelte';
  import { colorMap } from '$lib/colors';
  import ColorPicker from './ColorPicker.svelte';

  let { note, onEdit }: { note: Note; onEdit: (note: Note) => void } = $props();

  let showActions = $state(false);
  let showColorPicker = $state(false);
  let actionsVisible = $derived(showActions || showColorPicker);

  function bgColor() {
    return colorMap[note.color ?? 'default'] ?? colorMap['default'];
  }

  async function handleDelete() {
    const deleted = await noteStore.deleteNote(note.id);
    if (deleted) {
      toastStore.show('Note deleted', {
        action: {
          label: 'Undo',
          fn: () => noteStore.undoDelete(deleted),
        },
        timeout: 3000,
      });
    }
  }

  function handleCopy() {
    const text = note.checkboxes
      ? note.checkboxes.map(c => `${c.checked ? '☑' : '☐'} ${c.text}`).join('\n')
      : note.content;
    navigator.clipboard.writeText(text);
    toastStore.show('Copied to clipboard');
  }
</script>

<div
  class="rounded-lg border border-border p-3 cursor-pointer transition-shadow duration-100 hover:shadow-md relative group break-inside-avoid mb-3"
  style="background-color: {bgColor()}"
  role="button"
  tabindex="0"
  onclick={() => onEdit(note)}
  onkeydown={(e) => { if (e.key === 'Enter') onEdit(note); }}
  onmouseenter={() => showActions = true}
  onmouseleave={() => { showActions = false; showColorPicker = false; }}
>
  {#if note.pinned}
    <div class="absolute top-2 right-2 text-on-surface-muted" title="Pinned">
      <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path d="M10 2a1 1 0 011 1v1.323l3.954 1.582 1.599-.8a1 1 0 01.894 1.79l-1.233.615L17 11a1 1 0 01-.293.707l-3 3A1 1 0 0113 15v-2.586l-2.293 2.293a1 1 0 01-1.414-1.414L11.586 11H9a1 1 0 01-.707-.293l-3-3A1 1 0 015 7l.786-3.49-1.233-.615a1 1 0 01.894-1.79l1.599.8L11 1.322V3a1 1 0 01-1-1z"/></svg>
    </div>
  {/if}

  {#if note.title}
    <h3 class="font-semibold text-on-surface mb-2 pr-5">{note.title}</h3>
  {/if}

  {#if note.images?.some(image => image.url)}
    {#each note.images.filter(image => image.url).slice(0, 1) as image}
      <img src={image.url} alt={image.name} class="w-full max-h-48 object-cover rounded mb-2" />
    {/each}
  {/if}

  {#if note.checkboxes && note.checkboxes.length > 0}
    <ul class="space-y-1 text-sm text-on-surface">
      {#each note.checkboxes.slice(0, 8) as item}
        <li class="flex items-center gap-2">
          <span class={item.checked ? 'line-through text-on-surface-muted' : ''}>{item.checked ? '☑' : '☐'} {item.text}</span>
        </li>
      {/each}
      {#if note.checkboxes.length > 8}
        <li class="text-on-surface-muted text-xs">+{note.checkboxes.length - 8} more items</li>
      {/if}
    </ul>
  {:else}
    <p class="text-sm text-on-surface whitespace-pre-wrap line-clamp-6">{note.content}</p>
  {/if}

  {#if note.labels?.length}
    <div class="flex flex-wrap gap-1 mt-2">
      {#each note.labels as label}
        <span class="rounded-full bg-black/10 px-2 py-0.5 text-xs text-on-surface-muted">{label}</span>
      {/each}
    </div>
  {/if}

  <!-- Action buttons - show on hover, focus-within, or touch devices -->
  <div
    class="note-actions flex items-center gap-1 mt-2 pt-2 border-t border-border/50 transition-opacity duration-150"
    class:opacity-0={!actionsVisible}
    class:opacity-100={actionsVisible}
  >
    <button
      onclick={(e) => { e.stopPropagation(); noteStore.togglePin(note.id); }}
      class="p-1.5 rounded-full hover:bg-black/10 dark:hover:bg-white/10 text-on-surface-muted hover:text-on-surface transition-colors"
      title={note.pinned ? 'Unpin' : 'Pin'}
      aria-label={note.pinned ? 'Unpin' : 'Pin'}
    >
      <svg class="w-4 h-4" fill={note.pinned ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z"/></svg>
    </button>
    <button
      onclick={(e) => { e.stopPropagation(); noteStore.toggleArchive(note.id); }}
      class="p-1.5 rounded-full hover:bg-black/10 dark:hover:bg-white/10 text-on-surface-muted hover:text-on-surface transition-colors"
      title={note.archived ? 'Unarchive' : 'Archive'}
      aria-label={note.archived ? 'Unarchive' : 'Archive'}
    >
      <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4"/></svg>
    </button>
    <button
      onclick={(e) => { e.stopPropagation(); showColorPicker = !showColorPicker; }}
      class="p-1.5 rounded-full hover:bg-black/10 dark:hover:bg-white/10 text-on-surface-muted hover:text-on-surface transition-colors"
      title="Change color"
      aria-label="Change color"
    >
      <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01"/></svg>
    </button>
    <button
      onclick={(e) => { e.stopPropagation(); handleCopy(); }}
      class="p-1.5 rounded-full hover:bg-black/10 dark:hover:bg-white/10 text-on-surface-muted hover:text-on-surface transition-colors"
      title="Copy"
      aria-label="Copy"
    >
      <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>
    </button>
    <button
      onclick={(e) => { e.stopPropagation(); handleDelete(); }}
      class="p-1.5 rounded-full hover:bg-black/10 dark:hover:bg-white/10 text-danger transition-colors ml-auto"
      title="Delete"
      aria-label="Delete"
    >
      <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
    </button>
  </div>
  {#if showColorPicker}
    <div class="absolute left-0 bottom-full mb-1 z-20">
      <ColorPicker
        selected={note.color ?? 'default'}
        onSelect={(color) => { noteStore.setColor(note.id, color); showColorPicker = false; }}
      />
    </div>
  {/if}
</div>

<style>
  /* Show actions when card has focus-within (keyboard/touch) */
  .group:focus-within .note-actions {
    opacity: 1 !important;
  }

  /* On touch devices (no hover), show actions at reduced opacity by default */
  @media (hover: none) {
    .note-actions {
      opacity: 0.6 !important;
    }
    .note-actions:focus-within,
    .group:active .note-actions {
      opacity: 1 !important;
    }
  }
</style>
