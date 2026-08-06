<script lang="ts">
  import type { Note } from '@unkeep/core';
  import NoteCard from './NoteCard.svelte';

  let {
    pinnedNotes,
    unpinnedNotes,
    onEdit,
    emptyMessage,
    trashed = false,
    selectedIds,
    onSelect,
    onPermanentDelete,
  }: {
    pinnedNotes: Note[];
    unpinnedNotes: Note[];
    onEdit: (note: Note) => void;
    emptyMessage?: string;
    trashed?: boolean;
    selectedIds?: Set<string>;
    onSelect?: (note: Note, selected: boolean) => void;
    onPermanentDelete?: (note: Note) => void;
  } = $props();
</script>

{#if pinnedNotes.length > 0}
  <div class="mb-6">
    <h2 class="text-xs font-semibold text-on-surface-muted uppercase tracking-wide mb-3 px-1">Pinned</h2>
    <div class="note-columns">
      {#each pinnedNotes as note (note.id)}
        <NoteCard {note} {onEdit} {trashed} selected={selectedIds?.has(note.id)} {onSelect} {onPermanentDelete} />
      {/each}
    </div>
  </div>
{/if}

{#if unpinnedNotes.length > 0}
  {#if pinnedNotes.length > 0}
    <h2 class="text-xs font-semibold text-on-surface-muted uppercase tracking-wide mb-3 px-1">Others</h2>
  {/if}
  <div class="note-columns">
    {#each unpinnedNotes as note (note.id)}
      <NoteCard {note} {onEdit} {trashed} selected={selectedIds?.has(note.id)} {onSelect} {onPermanentDelete} />
    {/each}
  </div>
{/if}

<style>
  .note-columns {
    column-gap: 1rem;
    column-width: 14.75rem;
  }
</style>

{#if pinnedNotes.length === 0 && unpinnedNotes.length === 0}
  <div class="text-center py-16 text-on-surface-muted">
    <svg class="w-16 h-16 mx-auto mb-4 opacity-30" fill="none" stroke="currentColor" stroke-width="1" viewBox="0 0 24 24"><path d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
    <p class="text-lg">{emptyMessage ?? 'No notes yet'}</p>
    {#if !emptyMessage}
      <p class="text-sm mt-1">Click above to create your first note</p>
    {/if}
  </div>
{/if}
