<script lang="ts">
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
  import AppMenu from '$lib/components/AppMenu.svelte';
  import { listPendingShares, removePendingShares } from '$lib/shareTarget';
  import { toastStore } from '$lib/toast.svelte';

  type ContentView = 'notes' | 'trash';
  interface DeleteConfirmation { ids: string[]; emptyAll: boolean }

  let editingNote: Note | null = $state(null);
  let contentView = $state<ContentView>('notes');
  let showImporter = $state(false);
  let showAccessManager = $state(false);
  let vaultReady = $state(false);
  let exporting = $state(false);
  let selectedTrashIds = $state(new Set<string>());
  let deleteConfirmation = $state<DeleteConfirmation | null>(null);
  let destructiveBusy = $state(false);
  let deleteDialog: HTMLDivElement | undefined = $state();
  let previousSearch = noteStore.searchQuery;

  let allTrashedNotes = $derived(noteStore.notes
    .filter(note => !note.deleted && note.trashedAt !== undefined));
  let selectedTrashNotes = $derived(allTrashedNotes
    .filter(note => selectedTrashIds.has(note.id)));
  let allVisibleTrashSelected = $derived(noteStore.trashedNotes.length > 0
    && noteStore.trashedNotes.every(note => selectedTrashIds.has(note.id)));

  $effect(() => {
    const currentSearch = noteStore.searchQuery;
    if (currentSearch !== previousSearch) {
      previousSearch = currentSearch;
      selectedTrashIds = new Set();
    }
  });

  $effect(() => {
    if (deleteConfirmation) queueMicrotask(() => deleteDialog?.focus());
  });

  function handleDeleteDialogKeydown(event: KeyboardEvent) {
    if (!deleteConfirmation) return;
    if (event.key === 'Escape' && !destructiveBusy) {
      event.preventDefault();
      deleteConfirmation = null;
      return;
    }
    if (event.key !== 'Tab' || !deleteDialog) return;
    const focusable = [...deleteDialog.querySelectorAll<HTMLButtonElement>('button:not([disabled])')];
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
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

  function showNotes() {
    contentView = 'notes';
    selectedTrashIds = new Set();
    editingNote = null;
  }

  function showTrash() {
    contentView = 'trash';
    selectedTrashIds = new Set();
    editingNote = null;
  }

  function setTrashSelected(note: Note, selected: boolean) {
    const next = new Set(selectedTrashIds);
    if (selected) next.add(note.id);
    else next.delete(note.id);
    selectedTrashIds = next;
  }

  function toggleSelectAllVisible() {
    const next = new Set(selectedTrashIds);
    if (allVisibleTrashSelected) {
      for (const note of noteStore.trashedNotes) next.delete(note.id);
    } else {
      for (const note of noteStore.trashedNotes) next.add(note.id);
    }
    selectedTrashIds = next;
  }

  async function restoreSelected() {
    const notes = [...selectedTrashNotes];
    let restored = 0;
    for (const note of notes) {
      if (await noteStore.restoreTrashedNote(note.id)) restored += 1;
    }
    selectedTrashIds = new Set();
    if (restored) toastStore.show(`Restored ${restored} note${restored === 1 ? '' : 's'}`);
  }

  function requestPermanentDelete(notes: Note[], emptyAll = false) {
    if (!notes.length) return;
    deleteConfirmation = { ids: notes.map(note => note.id), emptyAll };
  }

  async function confirmPermanentDelete() {
    if (!deleteConfirmation || destructiveBusy) return;
    destructiveBusy = true;
    const ids = [...deleteConfirmation.ids];
    let deleted = 0;
    for (const id of ids) {
      if (await noteStore.permanentlyDeleteNote(id)) deleted += 1;
    }
    destructiveBusy = false;
    deleteConfirmation = null;
    selectedTrashIds = new Set();
    if (editingNote && ids.includes(editingNote.id)) editingNote = null;
    if (deleted) toastStore.show(`Permanently deleted ${deleted} note${deleted === 1 ? '' : 's'}`);
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

<AuthVaultGate
  onReady={handleVaultReady}
  onSignedOut={async () => {
    await noteStore.disableEncryptedSync();
    vaultReady = false;
    showAccessManager = false;
  }}
  manageAccessOpen={showAccessManager}
  onManageAccessClose={() => showAccessManager = false}
/>

{#if vaultReady}
  <main class="min-h-dvh bg-surface">
    <header class="sticky top-0 z-40 border-b border-border bg-surface/95 pt-[env(safe-area-inset-top)] backdrop-blur-md">
      <div class="mx-auto grid min-h-16 max-w-[96rem] grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 px-3 sm:gap-5 sm:px-5">
        <button
          type="button"
          onclick={showNotes}
          class="flex shrink-0 items-center gap-2 rounded-lg pr-1 text-xl font-semibold text-on-surface focus-visible:outline-2 focus-visible:outline-primary sm:pr-3"
          aria-label="Show notes"
        >
          <img src="/icon.svg" alt="" class="h-9 w-9" />
          <span class="hidden lg:inline">UnKeep</span>
        </button>

        <div class="mx-auto w-full min-w-0 max-w-3xl"><SearchBar scope={contentView} /></div>

        <div class="flex shrink-0 items-center gap-1 sm:gap-2">
          <SyncStatus />
          <AppMenu
            inTrash={contentView === 'trash'}
            {exporting}
            onShowNotes={showNotes}
            onShowTrash={showTrash}
            onImport={() => showImporter = true}
            onExport={() => void handleExport()}
            onManageAccess={() => showAccessManager = true}
          />
        </div>
      </div>
    </header>

    <div class="mx-auto max-w-[90rem] px-3 pb-[calc(2rem+env(safe-area-inset-bottom))] pt-6 sm:px-5 sm:pt-8">
      {#if noteStore.loading}
        <div class="flex items-center justify-center py-16">
          <svg class="h-8 w-8 animate-spin text-primary" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
        </div>
      {:else if contentView === 'trash'}
        <section aria-labelledby="trash-heading">
          <div class="mb-6 flex flex-wrap items-center gap-3 border-b border-border pb-4">
            <button
              type="button"
              class="grid h-10 w-10 place-items-center rounded-full text-on-surface-muted hover:bg-surface-dim hover:text-on-surface focus-visible:outline-2 focus-visible:outline-primary"
              aria-label="Back to notes"
              onclick={showNotes}
            >
              <svg class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></svg>
            </button>
            <div class="mr-auto">
              <h1 id="trash-heading" class="text-xl font-semibold text-on-surface">Trash</h1>
              <p class="text-xs text-on-surface-muted">Notes stay here until you permanently delete them.</p>
            </div>
            {#if allTrashedNotes.length}
              <button
                type="button"
                class="rounded-lg px-3 py-2 text-sm text-danger hover:bg-danger/10 focus-visible:outline-2 focus-visible:outline-danger"
                onclick={() => requestPermanentDelete(allTrashedNotes, true)}
              >Empty Trash…</button>
            {/if}
          </div>

          {#if noteStore.trashedNotes.length}
            <div class="sticky top-[calc(4rem+env(safe-area-inset-top))] z-20 mb-5 flex min-h-12 flex-wrap items-center gap-2 rounded-xl border border-border bg-surface/95 px-3 py-2 shadow-sm backdrop-blur-md">
              <button
                type="button"
                class="rounded-md px-2.5 py-1.5 text-sm text-on-surface-muted hover:bg-surface-dim hover:text-on-surface"
                onclick={toggleSelectAllVisible}
              >{allVisibleTrashSelected ? 'Clear visible selection' : `Select all${noteStore.searchQuery.trim() ? ' results' : ''}`}</button>
              {#if selectedTrashNotes.length}
                <span class="text-sm text-on-surface-muted">{selectedTrashNotes.length} selected</span>
                <div class="ml-auto flex items-center gap-2">
                  <button type="button" class="rounded-lg px-3 py-1.5 text-sm font-medium text-on-surface hover:bg-surface-dim" onclick={() => void restoreSelected()}>Restore</button>
                  <button type="button" class="rounded-lg px-3 py-1.5 text-sm font-medium text-danger hover:bg-danger/10" onclick={() => requestPermanentDelete(selectedTrashNotes)}>Delete forever…</button>
                </div>
              {/if}
            </div>
          {/if}

          <NoteGrid
            pinnedNotes={[]}
            unpinnedNotes={noteStore.trashedNotes}
            onEdit={(note) => editingNote = note}
            emptyMessage={noteStore.searchQuery.trim() ? 'No trashed notes match this search' : 'Trash is empty'}
            trashed
            selectedIds={selectedTrashIds}
            onSelect={setTrashSelected}
            onPermanentDelete={(note) => requestPermanentDelete([note])}
          />
        </section>
      {:else}
        <NoteInput />
        <NoteGrid
          pinnedNotes={noteStore.pinnedNotes}
          unpinnedNotes={noteStore.unpinnedNotes}
          onEdit={(note) => editingNote = note}
        />
      {/if}
    </div>
  </main>

  {#if editingNote}
    <NoteEditor note={editingNote} onClose={() => editingNote = null} readOnly={contentView === 'trash'} />
  {/if}

  {#if showImporter}
    <KeepImporter onClose={() => showImporter = false} />
  {/if}

  {#if deleteConfirmation}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="fixed inset-0 z-[70] grid place-items-center bg-black/55 p-4" onkeydown={handleDeleteDialogKeydown} onclick={(event) => { if (event.target === event.currentTarget && !destructiveBusy) deleteConfirmation = null; }}>
      <div bind:this={deleteDialog} class="w-full max-w-md rounded-2xl border border-border bg-surface p-5 shadow-2xl" role="alertdialog" aria-modal="true" aria-labelledby="delete-confirm-title" aria-describedby="delete-confirm-description" tabindex="-1">
        <h2 id="delete-confirm-title" class="text-lg font-semibold text-on-surface">
          {deleteConfirmation.emptyAll ? 'Empty Trash?' : 'Delete forever?'}
        </h2>
        <p id="delete-confirm-description" class="mt-2 text-sm leading-relaxed text-on-surface-muted">
          {deleteConfirmation.emptyAll
            ? `This permanently deletes all ${deleteConfirmation.ids.length} trashed notes from every synced device.`
            : `This permanently deletes ${deleteConfirmation.ids.length} selected note${deleteConfirmation.ids.length === 1 ? '' : 's'} from every synced device.`}
          This cannot be undone.
        </p>
        <div class="mt-5 flex justify-end gap-2">
          <button type="button" class="rounded-lg px-4 py-2 text-sm text-on-surface hover:bg-surface-dim" disabled={destructiveBusy} onclick={() => deleteConfirmation = null}>Cancel</button>
          <button type="button" class="rounded-lg bg-danger px-4 py-2 text-sm font-medium text-white disabled:opacity-60" disabled={destructiveBusy} onclick={() => void confirmPermanentDelete()}>{destructiveBusy ? 'Deleting…' : 'Delete forever'}</button>
        </div>
      </div>
    </div>
  {/if}

  <Toast />
{/if}
