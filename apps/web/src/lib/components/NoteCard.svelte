<script lang="ts">
  import type { Note } from '@unkeep/core';
  import { noteStore } from '$lib/noteStore.svelte';
  import { toastStore } from '$lib/toast.svelte';
  import { colorMap } from '$lib/colors';
  import { hasLocalAttachmentUrl, isImageAttachment } from '$lib/attachments';
  import AttachmentChip from './AttachmentChip.svelte';
  import ColorPicker from './ColorPicker.svelte';
  import LinkedText from './LinkedText.svelte';
  import PinIcon from './PinIcon.svelte';

  let {
    note,
    onEdit,
    trashed = false,
    selected = false,
    onSelect,
    onPermanentDelete,
  }: {
    note: Note;
    onEdit: (note: Note) => void;
    trashed?: boolean;
    selected?: boolean;
    onSelect?: (note: Note, selected: boolean) => void;
    onPermanentDelete?: (note: Note) => void;
  } = $props();

  let showActions = $state(false);
  let showColorPicker = $state(false);
  let actionsVisible = $derived(showActions || showColorPicker);
  let visibleImages = $derived(note.images?.filter(
    attachment => isImageAttachment(attachment) && hasLocalAttachmentUrl(attachment),
  ) ?? []);
  let editLabel = $derived.by(() => {
    const summary = note.title?.trim()
      || note.content.trim()
      || note.checkboxes?.find(item => item.text.trim())?.text.trim()
      || 'Untitled';
    return `${trashed ? 'View trashed note' : 'Edit note'}: ${summary.slice(0, 80)}`;
  });

  function bgColor() {
    return colorMap[note.color ?? 'default'] ?? colorMap['default'];
  }

  async function handleDelete() {
    if (await noteStore.trashNote(note.id)) {
      toastStore.show('Moved to Trash', {
        action: {
          label: 'Undo',
          fn: () => void noteStore.restoreTrashedNote(note.id),
        },
        timeout: 5000,
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

<article
  class="rounded-lg border border-border p-3 cursor-pointer transition-[box-shadow,border-color] duration-100 hover:shadow-md relative group break-inside-avoid mb-3 overflow-hidden"
  class:ring-2={selected}
  class:ring-primary={selected}
  style="background-color: {bgColor()}"
  onmouseenter={() => showActions = true}
  onmouseleave={() => { showActions = false; showColorPicker = false; }}
>
  <button
    type="button"
    class="absolute inset-0 z-10 rounded-lg bg-transparent outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset"
    aria-label={editLabel}
    onclick={() => onEdit(note)}
  ></button>

  {#if trashed}
    <label
      class="pointer-events-auto absolute left-2 top-2 z-30 grid h-8 w-8 cursor-pointer place-items-center rounded-full bg-surface/90 shadow-sm"
      title={selected ? 'Deselect note' : 'Select note'}
    >
      <input
        type="checkbox"
        class="h-4 w-4 accent-primary"
        checked={selected}
        aria-label={selected ? 'Deselect note' : 'Select note'}
        onclick={(event) => event.stopPropagation()}
        onchange={(event) => onSelect?.(note, event.currentTarget.checked)}
      />
    </label>
  {/if}

  <div class="pointer-events-none relative z-20">
  {#if note.pinned && !trashed}
    <div class="absolute top-2 right-2 text-on-surface-muted" title="Pinned">
      <PinIcon filled />
    </div>
  {/if}

  {#if visibleImages.length}
    <div
      class="-mx-3 -mt-3 mb-3 grid overflow-hidden border-b border-border/50"
      class:grid-cols-2={visibleImages.length > 1}
    >
      {#each visibleImages.slice(0, 4) as attachment, index}
        <div class="relative min-h-28 bg-black/10" class:col-span-2={visibleImages.length === 3 && index === 0}>
          <img
            src={attachment.url}
            alt={attachment.name}
            class="h-full max-h-56 min-h-28 w-full object-cover"
          />
          {#if index === 3 && visibleImages.length > 4}
            <span class="absolute inset-0 grid place-items-center bg-black/55 text-lg font-semibold text-white">
              +{visibleImages.length - 4}
            </span>
          {/if}
        </div>
      {/each}
    </div>
  {/if}

  {#if note.title}
    <h3 class="font-semibold text-on-surface mb-2 pr-5">{note.title}</h3>
  {/if}

  {#if note.images?.some(attachment => !isImageAttachment(attachment))}
    <div class="pointer-events-auto relative z-20 grid gap-2 mb-2">
      {#each note.images.filter(attachment => !isImageAttachment(attachment)) as attachment}
        <AttachmentChip {attachment} />
      {/each}
    </div>
  {/if}

  {#if note.checkboxes && note.checkboxes.length > 0}
    <ul class="space-y-1 text-sm text-on-surface">
      {#each note.checkboxes.slice(0, 8) as item}
        <li class="flex items-center gap-2">
          <span class={item.checked ? 'line-through text-on-surface-muted' : ''}>{item.checked ? '☑' : '☐'} <LinkedText text={item.text} /></span>
        </li>
      {/each}
      {#if note.checkboxes.length > 8}
        <li class="text-on-surface-muted text-xs">+{note.checkboxes.length - 8} more items</li>
      {/if}
    </ul>
  {:else}
    <p class="text-sm text-on-surface whitespace-pre-wrap line-clamp-6"><LinkedText text={note.content} /></p>
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
    class="note-actions pointer-events-auto relative z-20 flex items-center gap-1 mt-2 pt-2 border-t border-border/50 transition-opacity duration-150"
    class:opacity-0={!actionsVisible && !trashed}
    class:opacity-100={actionsVisible || trashed}
  >
    {#if trashed}
      <button
        type="button"
        onclick={(e) => { e.stopPropagation(); void noteStore.restoreTrashedNote(note.id); }}
        class="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium text-on-surface-muted hover:bg-black/10 hover:text-on-surface dark:hover:bg-white/10"
        title="Restore note"
        aria-label="Restore note"
      >
        <svg class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M3 12a9 9 0 101.9-5.5M3 4v6h6"/></svg>
        Restore
      </button>
      <button
        type="button"
        onclick={(e) => { e.stopPropagation(); onPermanentDelete?.(note); }}
        class="ml-auto flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium text-danger hover:bg-danger/10"
        title="Delete forever"
        aria-label="Delete forever"
      >
        <svg class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
        Delete forever
      </button>
    {:else}
    <button
      type="button"
      onclick={(e) => { e.stopPropagation(); noteStore.togglePin(note.id); }}
      class="p-2 rounded-full hover:bg-black/10 dark:hover:bg-white/10 text-on-surface-muted hover:text-on-surface transition-colors"
      title={note.pinned ? 'Unpin' : 'Pin'}
      aria-label={note.pinned ? 'Unpin' : 'Pin'}
    >
      <PinIcon filled={note.pinned} />
    </button>
    <button
      type="button"
      onclick={(e) => { e.stopPropagation(); showColorPicker = !showColorPicker; }}
      class="p-2 rounded-full hover:bg-black/10 dark:hover:bg-white/10 text-on-surface-muted hover:text-on-surface transition-colors"
      title="Change color"
      aria-label="Change color"
    >
      <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01"/></svg>
    </button>
    <button
      type="button"
      onclick={(e) => { e.stopPropagation(); handleCopy(); }}
      class="p-2 rounded-full hover:bg-black/10 dark:hover:bg-white/10 text-on-surface-muted hover:text-on-surface transition-colors"
      title="Copy"
      aria-label="Copy"
    >
      <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>
    </button>
    <button
      type="button"
      onclick={(e) => { e.stopPropagation(); handleDelete(); }}
      class="p-2 rounded-full hover:bg-black/10 dark:hover:bg-white/10 text-danger transition-colors ml-auto"
      title="Move to Trash"
      aria-label="Move to Trash"
    >
      <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
    </button>
    {/if}
  </div>
  {#if showColorPicker}
    <div class="pointer-events-auto absolute left-0 bottom-full mb-1 z-30">
      <ColorPicker
        selected={note.color ?? 'default'}
        onSelect={(color) => { noteStore.setColor(note.id, color); showColorPicker = false; }}
      />
    </div>
  {/if}
  </div>
</article>

<style>
  /* Show actions when card has focus-within (keyboard/touch) */
  .group:focus-within .note-actions {
    opacity: 1 !important;
  }

  /* On touch devices (no hover), always show actions — half-faded icons read as broken */
  @media (hover: none) {
    .note-actions {
      opacity: 1 !important;
    }
  }
</style>
