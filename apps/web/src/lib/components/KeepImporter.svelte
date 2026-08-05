<script lang="ts">
  import { onMount } from 'svelte';
  import {
    parseKeepFiles,
    parseKeepZip,
    summarizeImport,
    type ImportedAttachment,
    type ImportPreview,
  } from '$lib/keepImporter';
  import { isVaultExportFile, parseVaultExport, readVaultExportFile } from '$lib/vaultExport';
  import { noteStore } from '$lib/noteStore.svelte';
  import { toastStore } from '$lib/toast.svelte';
  import type { Note } from '@unkeep/core';

  let { onClose }: { onClose: () => void } = $props();

  let step = $state<'upload' | 'preview' | 'importing' | 'done'>('upload');
  let preview = $state<ImportPreview | null>(null);
  let importNotes = $state<Note[]>([]);
  let importAttachments = $state<ImportedAttachment[]>([]);
  let importedCount = $state(0);
  let dragOver = $state(false);
  let dialogEl: HTMLDivElement | undefined = $state();
  let importSource = $state<'Google Keep' | 'UnKeep backup'>('Google Keep');

  onMount(() => {
    const previouslyFocused = document.activeElement;
    dialogEl?.focus();

    return () => {
      if (previouslyFocused instanceof HTMLElement && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    };
  });

  function handleDialogKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab' || !dialogEl) return;

    const focusable = [...dialogEl.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
    )].filter(element => !element.hasAttribute('hidden') && element.getAttribute('aria-hidden') !== 'true');
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) {
      event.preventDefault();
      dialogEl.focus();
      return;
    }

    const active = document.activeElement;
    const focusStartsAtDialog = active === dialogEl || !dialogEl.contains(active);
    if (event.shiftKey && (active === first || focusStartsAtDialog)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || focusStartsAtDialog)) {
      event.preventDefault();
      first.focus();
    }
  }

  async function handleFiles(files: FileList | File[]) {
    const fileArray = Array.from(files);
    try {
      if (fileArray.length === 1 && await isVaultExportFile(fileArray[0])) {
        const serialized = await readVaultExportFile(fileArray[0]);
        const restored = parseVaultExport(serialized);
        importNotes = restored.notes;
        importAttachments = restored.attachments;
        preview = summarizeImport(restored.notes);
        importSource = 'UnKeep backup';
        step = 'preview';
        return;
      }
      importSource = 'Google Keep';
      if (fileArray.length === 1 && fileArray[0].name.endsWith('.zip')) {
        const result = await parseKeepZip(fileArray[0]);
        importNotes = result.notes;
        importAttachments = result.attachments;
        preview = result.preview;
      } else {
        const result = await parseKeepFiles(fileArray);
        importNotes = result.notes;
        importAttachments = result.attachments;
        preview = result.preview;
      }
      step = 'preview';
    } catch (e) {
      toastStore.show(`Import error: ${e}`);
    }
  }

  async function handleImport() {
    step = 'importing';
    const nonTrashed = importNotes.filter(n => !n.deleted);
    const importedIds = new Set(nonTrashed.map(note => note.id));
    try {
      importedCount = await noteStore.importNotes(
        nonTrashed,
        importAttachments.filter(attachment => importedIds.has(attachment.noteId)),
      );
      step = 'done';
      toastStore.show(`Imported ${importedCount} notes!`);
    } catch (error) {
      step = 'preview';
      toastStore.show(`Import failed; no notes were restored: ${error}`);
    }
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    dragOver = false;
    if (e.dataTransfer?.files) {
      handleFiles(e.dataTransfer.files);
    }
  }

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    dragOver = true;
  }
</script>

<div class="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/50 p-4">
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    bind:this={dialogEl}
    class="flex max-h-[calc(100dvh-2rem)] w-full max-w-lg flex-col overflow-hidden rounded-lg bg-surface shadow-xl"
    role="dialog"
    aria-modal="true"
    aria-label="Import notes"
    tabindex="-1"
    onclick={(e) => e.stopPropagation()}
    onkeydown={handleDialogKeydown}
  >
    <div class="flex shrink-0 items-center justify-between border-b border-border p-4">
      <h2 class="text-lg font-semibold text-on-surface">Import Notes</h2>
      <button type="button" onclick={onClose} class="p-1 hover:bg-surface-dim rounded-full text-on-surface-muted" aria-label="Close import dialog">
        <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M6 18L18 6M6 6l12 12"/></svg>
      </button>
    </div>

    <div class="min-h-0 overflow-y-auto p-4">
      {#if step === 'upload'}
        <p class="text-sm text-on-surface-muted mb-4">
          Upload a Google Takeout ZIP, its extracted Keep files, or a complete UnKeep vault export.
        </p>

        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="border-2 border-dashed rounded-lg p-8 text-center transition-colors"
          class:border-primary={dragOver}
          class:border-border={!dragOver}
          style:background-color={dragOver ? 'color-mix(in srgb, var(--color-primary) 5%, transparent)' : undefined}
          ondrop={handleDrop}
          ondragover={handleDragOver}
          ondragleave={() => dragOver = false}
        >
          <svg class="w-12 h-12 mx-auto mb-3 text-on-surface-muted" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5"/></svg>
          <p class="text-on-surface font-medium">Drop a Takeout ZIP or UnKeep export here</p>
          <p class="text-sm text-on-surface-muted mt-1">You can also drop the JSON and media files from a Keep folder</p>
          <input
            id="keep-import-files"
            type="file"
            accept=".zip,.json,image/*,audio/*"
            multiple
            class="peer sr-only"
            onchange={(e) => { if (e.currentTarget.files) handleFiles(e.currentTarget.files); }}
          />
          <label
            for="keep-import-files"
            class="mt-4 inline-block cursor-pointer rounded-lg bg-primary px-4 py-2 text-on-primary transition-colors hover:bg-primary-dim peer-focus-visible:ring-2 peer-focus-visible:ring-primary peer-focus-visible:ring-offset-2"
          >
            Browse files
          </label>
        </div>

      {:else if step === 'preview'}
        <div class="space-y-4">
          <p class="text-sm text-on-surface-muted">Ready to import from {importSource}.</p>
          <div class="grid grid-cols-2 gap-3">
            <div class="bg-surface-dim rounded-lg p-3 text-center">
              <div class="text-2xl font-bold text-on-surface">{preview?.total}</div>
              <div class="text-xs text-on-surface-muted">Total notes</div>
            </div>
            <div class="bg-surface-dim rounded-lg p-3 text-center">
              <div class="text-2xl font-bold text-on-surface">{preview?.checklists}</div>
              <div class="text-xs text-on-surface-muted">Checklists</div>
            </div>
            <div class="bg-surface-dim rounded-lg p-3 text-center">
              <div class="text-2xl font-bold text-on-surface">{preview?.pinned}</div>
              <div class="text-xs text-on-surface-muted">Pinned</div>
            </div>
            <div class="bg-surface-dim rounded-lg p-3 text-center">
              <div class="text-2xl font-bold text-on-surface">{preview?.archived}</div>
              <div class="text-xs text-on-surface-muted">Previously archived</div>
            </div>
          </div>

          {#if preview?.trashed && preview.trashed > 0}
            <p class="text-sm text-on-surface-muted">
              {preview.trashed} trashed notes will be skipped.
            </p>
          {/if}
          {#if preview?.archived && preview.archived > 0}
            <p class="text-sm text-on-surface-muted">
              Previously archived notes will appear with your other notes.
            </p>
          {/if}

          {#if preview?.samples && preview.samples.length > 0}
            <div>
              <h3 class="text-sm font-medium text-on-surface mb-2">Sample notes:</h3>
              <div class="space-y-2 max-h-48 overflow-y-auto">
                {#each preview.samples as sample}
                  <div class="bg-surface-dim rounded p-2 text-sm text-on-surface">
                    <p class="line-clamp-2">{sample.content || (sample.checkboxes ? sample.checkboxes.map(c => c.text).join(', ') : '(empty)')}</p>
                  </div>
                {/each}
              </div>
            </div>
          {/if}

          <div class="flex gap-3">
            <button
              onclick={() => { step = 'upload'; preview = null; }}
              class="flex-1 py-2.5 border border-border rounded-lg text-on-surface hover:bg-surface-dim transition-colors"
            >
              Cancel
            </button>
            <button
              onclick={handleImport}
              class="flex-1 py-2.5 bg-primary text-on-primary rounded-lg font-medium hover:bg-primary-dim transition-colors"
            >
              Import {(preview?.total ?? 0) - (preview?.trashed ?? 0)} notes
            </button>
          </div>
        </div>

      {:else if step === 'importing'}
        <div class="text-center py-8">
          <svg class="w-8 h-8 mx-auto animate-spin text-primary" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
          <p class="mt-3 text-on-surface">Importing notes...</p>
        </div>

      {:else if step === 'done'}
        <div class="text-center py-8">
          <svg class="w-12 h-12 mx-auto text-green-500" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg>
          <p class="mt-3 text-on-surface font-medium">Imported {importedCount} notes!</p>
          <button
            onclick={onClose}
            class="mt-4 px-6 py-2 bg-primary text-on-primary rounded-lg hover:bg-primary-dim transition-colors"
          >
            Done
          </button>
        </div>
      {/if}
    </div>
  </div>
</div>
