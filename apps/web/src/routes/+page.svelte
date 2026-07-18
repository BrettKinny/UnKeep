<script lang="ts">
  import { onMount } from 'svelte';
  import type { Note } from '@unkeep/core';
  import { noteStore } from '$lib/noteStore.svelte';
  import NoteInput from '$lib/components/NoteInput.svelte';
  import NoteGrid from '$lib/components/NoteGrid.svelte';
  import NoteEditor from '$lib/components/NoteEditor.svelte';
  import SearchBar from '$lib/components/SearchBar.svelte';
  import SyncStatus from '$lib/components/SyncStatus.svelte';
  import Toast from '$lib/components/Toast.svelte';
  import AuthVaultGate, { type VaultReady } from '$lib/components/AuthVaultGate.svelte';
  import KeepImporter from '$lib/components/KeepImporter.svelte';

  let editingNote: Note | null = $state(null);
  let showArchive = $state(false);
  let showImporter = $state(false);
  let sidebarOpen = $state(false);
  let vaultReady = $state(false);

  onMount(() => {
    sidebarOpen = window.matchMedia('(min-width: 768px)').matches;
  });

  async function handleVaultReady(vault: VaultReady) {
    await noteStore.init();
    await noteStore.enableEncryptedSync(vault.session, vault.masterKey);
    vaultReady = true;
  }

  function handleEditNote(note: Note) {
    editingNote = note;
  }

  function handleCloseEditor() {
    editingNote = null;
  }
</script>

<AuthVaultGate onReady={handleVaultReady} onSignedOut={() => { noteStore.disableEncryptedSync(); vaultReady = false; }} />

{#if vaultReady}
  <main class="min-h-screen bg-surface">
    <header class="sticky top-0 z-30 flex min-h-16 items-center gap-1.5 border-b border-border bg-surface/95 px-2 pr-12 pt-[env(safe-area-inset-top)] backdrop-blur-sm sm:gap-3 sm:px-3 sm:pr-14">
      <button
        onclick={() => sidebarOpen = !sidebarOpen}
        class="shrink-0 rounded-full p-2.5 text-on-surface-muted hover:bg-surface-dim hover:text-on-surface"
        aria-label="Toggle navigation"
      >
        <svg class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h16"/></svg>
      </button>
      <button
        onclick={() => { showArchive = false; }}
        class="flex shrink-0 items-center gap-2 text-xl font-semibold text-on-surface"
      >
        <img src="/icon.svg" alt="" class="h-8 w-8 sm:h-9 sm:w-9" />
        <span class="hidden md:inline">UnKeep</span>
      </button>

      <div class="mx-auto w-full min-w-0 max-w-3xl"><SearchBar /></div>

      <div class="flex shrink-0 items-center gap-0.5 sm:gap-1">
        <SyncStatus />
        <button
          onclick={() => showImporter = true}
          class="hidden rounded-full p-2 text-on-surface-muted hover:bg-surface-dim hover:text-on-surface sm:block"
          title="Import notes"
          aria-label="Import notes"
        >
          <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/></svg>
        </button>
      </div>
    </header>

    {#if sidebarOpen}
      <button class="fixed inset-0 z-10 bg-black/30 md:hidden" aria-label="Close navigation" onclick={() => sidebarOpen = false}></button>
    {/if}
    <aside
      class="fixed bottom-0 left-0 top-[calc(4rem+env(safe-area-inset-top))] z-20 w-64 border-r border-border bg-surface py-3 transition-transform"
      class:-translate-x-full={!sidebarOpen}
    >
      <nav class="space-y-1 pr-3">
        <button
          class="flex w-full items-center gap-5 rounded-r-full px-6 py-3 text-sm font-medium {!showArchive ? 'bg-primary/15 text-primary' : ''}"
          onclick={() => { showArchive = false; sidebarOpen = false; }}
        >
          <svg class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M9 18h6M10 22h4M8 14a7 7 0 118 0c-1 1-2 2-2 4h-4c0-2-1-3-2-4z"/></svg>
          Notes
        </button>
        <button
          class="flex w-full items-center gap-5 rounded-r-full px-6 py-3 text-sm font-medium {showArchive ? 'bg-primary/15 text-primary' : ''}"
          onclick={() => { showArchive = true; sidebarOpen = false; }}
        >
          <svg class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4"/></svg>
          Archive
        </button>
        <button
          class="flex w-full items-center gap-5 rounded-r-full px-6 py-3 text-sm font-medium hover:bg-surface-dim"
          onclick={() => { showImporter = true; sidebarOpen = false; }}
        >
          <svg class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/></svg>
          Import from Keep
        </button>
      </nav>
      <p class="absolute bottom-4 left-6 text-xs text-on-surface-muted">End-to-end encrypted</p>
    </aside>

    <div class="px-3 pt-6 pb-[calc(2rem+env(safe-area-inset-bottom))] transition-[margin] sm:px-4 sm:pt-8 md:px-8 {sidebarOpen ? 'md:ml-64' : ''}">
      <div class="mx-auto max-w-7xl">
      {#if noteStore.loading}
        <div class="flex items-center justify-center py-16">
          <svg class="w-8 h-8 animate-spin text-primary" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
        </div>
      {:else if showArchive}
        <h2 class="mb-5 text-sm font-medium uppercase tracking-wide text-on-surface-muted">Archive</h2>
        <NoteGrid
          pinnedNotes={[]}
          unpinnedNotes={noteStore.archivedNotes}
          onEdit={handleEditNote}
          emptyMessage="No archived notes"
        />
      {:else}
        <NoteInput />
        <NoteGrid
          pinnedNotes={noteStore.pinnedNotes}
          unpinnedNotes={noteStore.unpinnedNotes}
          onEdit={handleEditNote}
        />
      {/if}
      </div>
    </div>
  </main>

  <!-- Note editor modal -->
  {#if editingNote}
    <NoteEditor note={editingNote} onClose={handleCloseEditor} />
  {/if}

  <!-- Keep importer modal -->
  {#if showImporter}
    <KeepImporter onClose={() => showImporter = false} />
  {/if}

  <!-- Toast notifications -->
  <Toast />
{/if}
