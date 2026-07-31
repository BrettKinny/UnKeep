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
  import { listPendingShares, removePendingShares } from '$lib/shareTarget';
  import { toastStore } from '$lib/toast.svelte';

  let editingNote: Note | null = $state(null);
  let showArchive = $state(false);
  let showImporter = $state(false);
  let sidebarOpen = $state(false);
  let vaultReady = $state(false);
  let exporting = $state(false);
  let desktopMedia: MediaQueryList | null = null;

  onMount(() => {
    const media = window.matchMedia('(min-width: 768px)');
    desktopMedia = media;
    const syncSidebarToViewport = () => {
      if (media.matches) sidebarOpen = true;
      if (!media.matches) sidebarOpen = false;
    };
    syncSidebarToViewport();
    media.addEventListener('change', syncSidebarToViewport);
    return () => media.removeEventListener('change', syncSidebarToViewport);
  });

  function closeSidebarOnMobile() {
    if (!desktopMedia?.matches) sidebarOpen = false;
  }

  async function handleVaultReady(vault: VaultReady) {
    await noteStore.init(vault.ownerId, vault.migrateLegacy);
    await noteStore.enableEncryptedSync(vault.session, vault.masterKey);
    vaultReady = true;
    const pending = listPendingShares();
    const matching = pending.filter(share => share.targetInstanceId === vault.session.instanceId);
    const unbound = pending.filter(share => share.targetInstanceId === null);
    const foreign = pending.filter(
      share => share.targetInstanceId !== null && share.targetInstanceId !== vault.session.instanceId,
    );
    const acceptedUnbound = !unbound.length || window.confirm(
      `Save ${unbound.length} pending shared note${unbound.length === 1 ? '' : 's'} to this vault?`,
    );
    const shares = acceptedUnbound ? [...matching, ...unbound] : matching;
    const savedIds: string[] = [];
    let failures = 0;
    for (const share of shares) {
      try {
        await noteStore.createReceivedNote(
          { title: share.title, content: share.text },
          { idempotencyKey: share.id, createdAt: share.createdAt },
        );
        savedIds.push(share.id);
      } catch {
        failures += 1;
      }
    }
    removePendingShares(savedIds);
    if (failures) {
      toastStore.show(`${failures} shared note${failures === 1 ? '' : 's'} could not be saved and remain pending`);
    } else if (savedIds.length === 1) {
      toastStore.show('Shared note saved');
    } else if (savedIds.length > 1) {
      toastStore.show(`${savedIds.length} shared notes saved`);
    } else if (unbound.length && !acceptedUnbound) {
      toastStore.show('Shared notes remain pending until you choose a vault');
    } else if (foreign.length) {
      toastStore.show(`${foreign.length} shared note${foreign.length === 1 ? '' : 's'} belongs to another vault`);
    }
  }

  function handleEditNote(note: Note) {
    editingNote = note;
  }

  function handleCloseEditor() {
    editingNote = null;
  }

  async function handleExport() {
    if (exporting) return;
    exporting = true;
    try {
      const serialized = await noteStore.exportVault();
      const url = URL.createObjectURL(new Blob([serialized], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `unkeep-vault-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      toastStore.show('Complete vault export downloaded');
    } catch (error) {
      toastStore.show(error instanceof Error ? error.message : 'Vault export failed');
    } finally {
      exporting = false;
    }
  }
</script>

<AuthVaultGate onReady={handleVaultReady} onSignedOut={async () => { await noteStore.disableEncryptedSync(); vaultReady = false; }} />

{#if vaultReady}
  <main class="min-h-screen bg-surface">
    <header class="sticky top-0 z-30 flex min-h-[calc(4rem+env(safe-area-inset-top))] items-center gap-1.5 border-b border-border bg-surface/95 px-2 pr-14 pt-[env(safe-area-inset-top)] backdrop-blur-sm sm:gap-3 sm:px-3">
      <button
        onclick={() => sidebarOpen = !sidebarOpen}
        class="shrink-0 rounded-full p-2 text-on-surface-muted hover:bg-surface-dim hover:text-on-surface"
        aria-label="Toggle navigation"
      >
        <svg class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h16"/></svg>
      </button>
      <button
        onclick={() => { showArchive = false; }}
        class="flex shrink-0 items-center gap-2 text-xl font-semibold text-on-surface"
        aria-label="Show notes"
      >
        <img src="/icon.svg" alt="" class="h-8 w-8 sm:h-9 sm:w-9" />
        <span class="hidden md:inline">UnKeep</span>
      </button>

      <div class="mx-auto w-full min-w-0 max-w-3xl"><SearchBar /></div>

      <div class="flex shrink-0 items-center gap-0.5 sm:gap-1">
        <SyncStatus />
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
          onclick={() => { showArchive = false; closeSidebarOnMobile(); }}
        >
          <svg class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M9 18h6M10 22h4M8 14a7 7 0 118 0c-1 1-2 2-2 4h-4c0-2-1-3-2-4z"/></svg>
          Notes
        </button>
        <button
          class="flex w-full items-center gap-5 rounded-r-full px-6 py-3 text-sm font-medium {showArchive ? 'bg-primary/15 text-primary' : ''}"
          onclick={() => { showArchive = true; closeSidebarOnMobile(); }}
        >
          <svg class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4"/></svg>
          Archive
        </button>
        <button
          class="flex w-full items-center gap-5 rounded-r-full px-6 py-3 text-sm font-medium hover:bg-surface-dim"
          onclick={() => { showImporter = true; closeSidebarOnMobile(); }}
        >
          <svg class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/></svg>
          Import from Keep
        </button>
        <button
          class="flex w-full items-center gap-5 rounded-r-full px-6 py-3 text-sm font-medium hover:bg-surface-dim disabled:opacity-50"
          onclick={() => void handleExport()}
          disabled={exporting}
        >
          <svg class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M12 3v12m0 0l4-4m-4 4l-4-4M5 17v2a2 2 0 002 2h10a2 2 0 002-2v-2"/></svg>
          {exporting ? 'Preparing export…' : 'Export vault'}
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
