<script lang="ts">
  import { onMount } from 'svelte';
  import type { Note } from '@unkeep/core';
  import { noteStore } from '$lib/noteStore.svelte';
  import { darkMode } from '$lib/darkMode.svelte';
  import { getSavedConfig, saveConfig } from '$lib/adapterConfig';
  import { getAdapter } from '$lib/adapterRegistry';
  import {
    getSavedTokens,
    saveTokens,
    isTokenExpired,
    refreshAccessToken,
  } from '$lib/oauth';
  import NoteInput from '$lib/components/NoteInput.svelte';
  import NoteGrid from '$lib/components/NoteGrid.svelte';
  import NoteEditor from '$lib/components/NoteEditor.svelte';
  import SearchBar from '$lib/components/SearchBar.svelte';
  import SyncStatus from '$lib/components/SyncStatus.svelte';
  import Toast from '$lib/components/Toast.svelte';
  import SetupWizard from '$lib/components/SetupWizard.svelte';
  import KeepImporter from '$lib/components/KeepImporter.svelte';

  let editingNote: Note | null = $state(null);
  let showArchive = $state(false);
  let showImporter = $state(false);
  let needsSetup = $state(true);
  let initializing = $state(true);

  onMount(async () => {
    const saved = getSavedConfig();
    if (saved) {
      try {
        const adapter = getAdapter(saved.adapterId);

        // Refresh expired OAuth tokens before initializing
        const tokens = getSavedTokens();
        if (tokens && tokens.adapterId === saved.adapterId && adapter.oauthConfig) {
          if (isTokenExpired(tokens) && tokens.refreshToken) {
            try {
              const clientId = saved.config.clientId as string;
              const clientSecret = saved.config.clientSecret as string | undefined;
              const refreshed = await refreshAccessToken(
                adapter.oauthConfig,
                clientId,
                tokens.refreshToken,
                clientSecret,
              );
              // Update stored tokens and adapter config with new access token
              saveTokens(saved.adapterId, refreshed);
              saved.config.accessToken = refreshed.accessToken;
              saveConfig(saved.adapterId, saved.config as Record<string, unknown>);
            } catch (e) {
              console.error('Token refresh failed, re-auth needed:', e);
              needsSetup = true;
              initializing = false;
              return;
            }
          }
        }

        await noteStore.initWithAdapter(adapter, saved.config);
        needsSetup = false;
      } catch (e) {
        console.error('Failed to restore adapter config:', e);
        needsSetup = true;
      }
    } else {
      needsSetup = true;
    }
    initializing = false;
  });

  function handleSetupComplete() {
    needsSetup = false;
  }

  function handleEditNote(note: Note) {
    editingNote = note;
  }

  function handleCloseEditor() {
    editingNote = null;
  }
</script>

{#if initializing}
  <div class="min-h-screen bg-surface flex items-center justify-center">
    <svg class="w-8 h-8 animate-spin text-primary" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
  </div>
{:else if needsSetup}
  <SetupWizard onComplete={handleSetupComplete} />
{:else}
  <main class="min-h-screen bg-surface">
    <!-- Header -->
    <header class="sticky top-0 z-10 bg-surface/95 backdrop-blur-sm border-b border-border px-4 py-3 flex items-center gap-3">
      <button
        onclick={() => { showArchive = false; }}
        class="text-xl font-semibold text-on-surface hover:text-primary transition-colors"
      >
        UnKeep
      </button>

      <SearchBar />

      <SyncStatus />

      <button
        onclick={() => showImporter = true}
        class="p-2 rounded-full hover:bg-surface-dim text-on-surface-muted hover:text-on-surface transition-colors"
        title="Import from Google Keep"
      >
        <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/></svg>
      </button>

      <button
        onclick={() => showArchive = !showArchive}
        class="p-2 rounded-full hover:bg-surface-dim text-on-surface-muted hover:text-on-surface transition-colors"
        title={showArchive ? 'Back to notes' : 'Archive'}
      >
        <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4"/></svg>
      </button>

      <button
        onclick={() => darkMode.toggle()}
        class="p-2 rounded-full hover:bg-surface-dim text-on-surface-muted hover:text-on-surface transition-colors"
        title={darkMode.enabled ? 'Light mode' : 'Dark mode'}
      >
        {#if darkMode.enabled}
          <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M10 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm4 8a4 4 0 11-8 0 4 4 0 018 0zm-.464 4.95l.707.707a1 1 0 001.414-1.414l-.707-.707a1 1 0 00-1.414 1.414zm2.12-10.607a1 1 0 010 1.414l-.706.707a1 1 0 11-1.414-1.414l.707-.707a1 1 0 011.414 0zM17 11a1 1 0 100-2h-1a1 1 0 100 2h1zm-7 4a1 1 0 011 1v1a1 1 0 11-2 0v-1a1 1 0 011-1zM5.05 6.464A1 1 0 106.465 5.05l-.708-.707a1 1 0 00-1.414 1.414l.707.707zm1.414 8.486l-.707.707a1 1 0 01-1.414-1.414l.707-.707a1 1 0 011.414 1.414zM4 11a1 1 0 100-2H3a1 1 0 000 2h1z" clip-rule="evenodd"/></svg>
        {:else}
          <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20"><path d="M17.293 13.293A8 8 0 016.707 2.707a8.001 8.001 0 1010.586 10.586z"/></svg>
        {/if}
      </button>
    </header>

    <!-- Content -->
    <div class="max-w-5xl mx-auto p-4">
      {#if noteStore.loading}
        <div class="flex items-center justify-center py-16">
          <svg class="w-8 h-8 animate-spin text-primary" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
        </div>
      {:else if showArchive}
        <h2 class="text-lg font-medium text-on-surface mb-4">Archive</h2>
        <NoteGrid
          pinnedNotes={[]}
          unpinnedNotes={noteStore.archivedNotes}
          onEdit={handleEditNote}
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
