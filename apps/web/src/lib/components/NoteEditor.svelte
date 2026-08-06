<script lang="ts">
  import { onMount, tick } from 'svelte';
  import type { Note } from '@unkeep/core';
  import { noteStore } from '$lib/noteStore.svelte';
  import { toastStore } from '$lib/toast.svelte';
  import { encodeQuickSendNote, getShareUrl } from '$lib/quickSend';
  import { colorMap } from '$lib/colors';
  import { hasLocalAttachmentUrl, isImageAttachment } from '$lib/attachments';
  import { parseMarkdown, type MarkdownInline } from '$lib/markdown';
  import {
    downloadNoteMarkdown,
    noteShareTitle,
    noteToShareMarkdown,
    noteToShareText,
    obsidianNewNoteUrl,
  } from '$lib/noteShare';
  import AttachmentChip from './AttachmentChip.svelte';
  import ColorPicker from './ColorPicker.svelte';
  import PinIcon from './PinIcon.svelte';
  import LinkedText from './LinkedText.svelte';

  let { note, onClose, readOnly = false }: { note: Note; onClose: () => void; readOnly?: boolean } = $props();

  // svelte-ignore state_referenced_locally
  let content = $state(note.content);
  // svelte-ignore state_referenced_locally
  let title = $state(note.title ?? '');
  // svelte-ignore state_referenced_locally
  let labelsText = $state((note.labels ?? []).join(', '));
  // svelte-ignore state_referenced_locally
  let lastNoteId = $state(note.id);

  $effect(() => {
    if (note.id !== lastNoteId) {
      content = note.content;
      title = note.title ?? '';
      labelsText = (note.labels ?? []).join(', ');
      showShareMenu = false;
      lastNoteId = note.id;
    }
  });
  let showColorPicker = $state(false);
  let showShareMenu = $state(false);
  let showMarkdown = $state(false);
  $effect(() => {
    if (readOnly && !note.checkboxes) showMarkdown = true;
  });
  let deleting = $state(false);
  let markdownBlocks = $derived(parseMarkdown(content));
  let dialogEl: HTMLDivElement | undefined = $state();
  let shareButtonEl: HTMLButtonElement | undefined = $state();
  let shareMenuEl: HTMLDivElement | undefined = $state();

  onMount(() => {
    const previouslyFocused = document.activeElement;
    dialogEl?.querySelector<HTMLInputElement>('#edit-note-title')?.focus();
    return () => {
      if (previouslyFocused instanceof HTMLElement && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    };
  });

  function bgColor() {
    return colorMap[note.color ?? 'default'] ?? colorMap['default'];
  }

  function handleContentChange() {
    if (readOnly) return;
    noteStore.updateNote(note.id, { content });
  }

  function handleTitleChange() {
    if (readOnly) return;
    noteStore.updateNote(note.id, { title });
  }

  function handleLabelsChange() {
    if (readOnly) return;
    const labels = [...new Set(labelsText.split(',').map(label => label.trim()).filter(Boolean))];
    noteStore.updateNote(note.id, { labels });
  }

  function handleCheckboxToggle(itemId: string, checked: boolean) {
    if (readOnly) return;
    noteStore.updateChecklistItem(note.id, itemId, { checked });
  }

  function handleCheckboxText(itemId: string, text: string) {
    if (readOnly) return;
    noteStore.updateChecklistItem(note.id, itemId, { text });
  }

  function handleAddCheckboxItem() {
    if (readOnly) return;
    noteStore.addChecklistItem(note.id, '');
  }

  function handleRemoveCheckboxItem(itemId: string) {
    noteStore.removeChecklistItem(note.id, itemId);
  }

  async function handleDelete() {
    if (deleting) return;
    deleting = true;
    try {
      const deleted = await noteStore.deleteNote(note.id);
      if (!deleted) return;
      onClose();
      toastStore.show('Note deleted', {
        action: {
          label: 'Undo',
          fn: () => noteStore.undoDelete(deleted),
        },
        timeout: 3000,
      });
    } finally {
      deleting = false;
    }
  }

  function handleDialogKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (showShareMenu) {
        showShareMenu = false;
        shareButtonEl?.focus();
        return;
      }
      onClose();
      return;
    }
    if (event.key === 'Tab' && dialogEl) {
      const focusable = [...dialogEl.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      )].filter(element => !element.hasAttribute('hidden'));
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
  }

  function handleBackdropClick(event: MouseEvent) {
    if (event.target === event.currentTarget) onClose();
  }

  async function openShareMenu() {
    showShareMenu = true;
    await tick();
    shareMenuEl?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }

  function closeShareMenu() {
    showShareMenu = false;
    shareButtonEl?.focus();
  }

  async function handleShare() {
    if (typeof navigator.share !== 'function') {
      await openShareMenu();
      return;
    }
    try {
      await navigator.share({
        title: noteShareTitle(note),
        text: noteToShareMarkdown(note),
      });
    } catch (error) {
      if (error && typeof error === 'object' && 'name' in error && error.name === 'AbortError') return;
      await openShareMenu();
      toastStore.show('Native sharing is unavailable here; choose another send option');
    }
  }

  async function copyShareValue(value: string, message: string) {
    try {
      await navigator.clipboard.writeText(value);
      closeShareMenu();
      toastStore.show(message);
    } catch {
      toastStore.show('Clipboard access is unavailable; download the Markdown file instead');
    }
  }

  async function handleOpenInObsidian() {
    try {
      await navigator.clipboard.writeText(noteToShareMarkdown(note));
      closeShareMenu();
      toastStore.show('Markdown copied; opening Obsidian…');
      window.location.href = obsidianNewNoteUrl(note);
    } catch {
      toastStore.show('Clipboard access is required to send this note to Obsidian');
    }
  }

  function handleDownloadMarkdown() {
    try {
      downloadNoteMarkdown(note);
      closeShareMenu();
      toastStore.show('Markdown note downloaded');
    } catch (error) {
      toastStore.show(error instanceof Error ? error.message : 'Could not download the note');
    }
  }

  async function handleQuickSend() {
    try {
      const encoded = await encodeQuickSendNote(await noteStore.prepareQuickSend(note));
      const url = getShareUrl(encoded);
      await navigator.clipboard.writeText(url);
      closeShareMenu();
      toastStore.show('Unencrypted Quick Send snapshot copied; anyone with the link can read it');
    } catch (error) {
      toastStore.show(error instanceof Error ? error.message : 'Could not create share link');
    }
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

{#snippet renderInline(content: MarkdownInline[])}
  {#each content as inline}
    {#if inline.type === 'text'}
      <LinkedText text={inline.text} />
    {:else if inline.type === 'lineBreak'}
      <br />
    {:else if inline.type === 'code'}
      <code class="rounded bg-black/10 px-1 py-0.5 font-mono text-[0.9em]">{inline.text}</code>
    {:else if inline.type === 'emphasis'}
      <em><LinkedText text={inline.text} /></em>
    {:else if inline.type === 'strong'}
      <strong><LinkedText text={inline.text} /></strong>
    {:else if inline.type === 'link'}
      <!-- The parser only emits absolute http(s) links. -->
      <!-- eslint-disable svelte/no-navigation-without-resolve -->
      <a
        href={inline.href}
        target="_blank"
        rel="noopener noreferrer"
        class="text-primary underline underline-offset-2 hover:no-underline"
      >{inline.text}</a>
      <!-- eslint-enable svelte/no-navigation-without-resolve -->
    {/if}
  {/each}
{/snippet}

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
  onclick={handleBackdropClick}
  onkeydown={handleDialogKeydown}
>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    bind:this={dialogEl}
    class="w-full max-w-lg rounded-lg shadow-xl max-h-[85dvh] flex flex-col"
    style="background-color: {bgColor()}"
    role="dialog"
    aria-modal="true"
    aria-label={readOnly ? 'View trashed note' : 'Edit note'}
    tabindex="-1"
  >
    <!-- Content -->
    <div class="flex-1 overflow-y-auto p-4">
      <label for="edit-note-title" class="sr-only">Note title</label>
      <input
        id="edit-note-title"
        bind:value={title}
        oninput={handleTitleChange}
        readonly={readOnly}
        class="w-full mb-3 bg-transparent text-lg font-semibold text-on-surface outline-none"
        placeholder="Title"
      />
      {#if note.images?.some(attachment => isImageAttachment(attachment) && hasLocalAttachmentUrl(attachment))}
        <div class="grid grid-cols-2 gap-2 mb-3">
          {#each note.images as attachment}
            {#if isImageAttachment(attachment) && hasLocalAttachmentUrl(attachment)}
              <figure class="group/attachment relative overflow-hidden rounded">
                <img src={attachment.url} alt={attachment.name} class="w-full max-h-48 object-cover" />
                {#if !readOnly}<button
                  type="button"
                  class="absolute right-2 top-2 grid h-8 w-8 place-items-center rounded-full bg-black/65 text-white opacity-80 hover:opacity-100 focus:opacity-100"
                  aria-label={`Remove ${attachment.name}`}
                  title={`Remove ${attachment.name}`}
                  onclick={() => void noteStore.removeAttachment(note.id, attachment.id)}
                >
                  <svg class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 18L18 6M6 6l12 12"/></svg>
                </button>{/if}
              </figure>
            {/if}
          {/each}
        </div>
      {/if}
      {#if note.images?.some(attachment => !isImageAttachment(attachment))}
        <div class="grid gap-2 mb-3">
          {#each note.images.filter(attachment => !isImageAttachment(attachment)) as attachment}
            <AttachmentChip
              {attachment}
              onRemove={readOnly ? undefined : () => void noteStore.removeAttachment(note.id, attachment.id)}
            />
          {/each}
        </div>
      {/if}
      {#if note.checkboxes}
        <ul class="space-y-2">
          {#each note.checkboxes as item, i}
            <li class="group flex items-center gap-2">
              <input
                type="checkbox"
                aria-label={`Mark ${item.text || 'checklist item'} ${item.checked ? 'incomplete' : 'complete'}`}
                checked={item.checked}
                disabled={readOnly}
                onchange={() => handleCheckboxToggle(item.id, !item.checked)}
                class="w-4 h-4 rounded"
              />
              <input
                type="text"
                aria-label="Checklist item"
                value={item.text}
                readonly={readOnly}
                oninput={(e) => handleCheckboxText(item.id, e.currentTarget.value)}
                onkeydown={(e) => handleCheckboxKeydown(e, i)}
                class="flex-1 bg-transparent text-on-surface outline-none checklist-input"
                placeholder="List item"
              />
              {#if !readOnly}<button
                onclick={() => handleRemoveCheckboxItem(item.id)}
                class="p-1 text-on-surface-muted hover:text-danger opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100 transition-opacity"
                aria-label="Remove item"
              >
                <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M6 18L18 6M6 6l12 12"/></svg>
              </button>{/if}
            </li>
          {/each}
          {#if !readOnly}<li>
            <button onclick={handleAddCheckboxItem} class="text-sm text-on-surface-muted hover:text-on-surface">
              + Add item
            </button>
          </li>{/if}
        </ul>
      {:else if showMarkdown}
        <div class="min-h-[200px] text-on-surface">
          {#each markdownBlocks as block}
            {#if block.type === 'heading'}
              <svelte:element
                this={`h${block.level}`}
                class="mb-2 mt-4 font-semibold leading-tight first:mt-0"
                class:text-2xl={block.level === 1}
                class:text-xl={block.level === 2}
                class:text-lg={block.level >= 3}
              >{@render renderInline(block.content)}</svelte:element>
            {:else if block.type === 'paragraph'}
              <p class="my-2 leading-relaxed first:mt-0">{@render renderInline(block.content)}</p>
            {:else if block.type === 'list' && block.ordered}
              <ol start={block.start} class="my-2 list-decimal space-y-1 pl-6">
                {#each block.items as item}
                  <li>{@render renderInline(item)}</li>
                {/each}
              </ol>
            {:else if block.type === 'list'}
              <ul class="my-2 list-disc space-y-1 pl-6">
                {#each block.items as item}
                  <li>{@render renderInline(item)}</li>
                {/each}
              </ul>
            {:else if block.type === 'codeBlock'}
              <div class="my-3 overflow-hidden rounded-lg border border-border/60 bg-black/10">
                {#if block.language}
                  <div class="border-b border-border/50 px-3 py-1 font-mono text-xs text-on-surface-muted">
                    {block.language}
                  </div>
                {/if}
                <pre class="overflow-x-auto p-3 text-sm"><code>{block.text}</code></pre>
              </div>
            {/if}
          {/each}
        </div>
      {:else}
        <label for="edit-note-content" class="sr-only">Note content</label>
        <textarea
          id="edit-note-content"
          bind:value={content}
          oninput={handleContentChange}
          readonly={readOnly}
          class="w-full min-h-[200px] bg-transparent text-on-surface resize-none outline-none"
          placeholder="Note content..."
        ></textarea>
      {/if}
      <label for="edit-note-labels" class="sr-only">Labels, separated by commas</label>
      <input
        id="edit-note-labels"
        bind:value={labelsText}
        onchange={handleLabelsChange}
        readonly={readOnly}
        class="w-full mt-4 bg-transparent text-base sm:text-sm text-on-surface-muted outline-none"
        placeholder="Labels, separated by commas"
      />
    </div>

    <!-- Toolbar -->
    <div class="flex items-center gap-1 p-3 border-t border-border/30">
      {#if !readOnly}<label
        class="p-2 rounded-full hover:bg-black/10 text-on-surface-muted hover:text-on-surface transition-colors cursor-pointer"
        title="Add attachment"
        aria-label="Add attachment"
      >
        <input
          type="file"
          class="sr-only"
          onchange={(event) => {
            const file = event.currentTarget.files?.[0];
            if (file) void noteStore.addAttachment(note.id, file);
            event.currentTarget.value = '';
          }}
        />
        <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>
      </label>
      <button
        onclick={() => noteStore.toggleChecklist(note.id)}
        class="p-2 rounded-full hover:bg-black/10 text-on-surface-muted hover:text-on-surface transition-colors"
        title={note.checkboxes ? 'Convert to text' : 'Convert to checklist'}
        aria-label={note.checkboxes ? 'Convert to text' : 'Convert to checklist'}
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"/></svg>
      </button>
      {#if !note.checkboxes}
        <button
          onclick={() => showMarkdown = !showMarkdown}
          class="p-2 rounded-full hover:bg-black/10 text-on-surface-muted hover:text-on-surface transition-colors"
          class:text-primary={showMarkdown}
          title={showMarkdown ? 'Edit' : 'Preview markdown'}
          aria-label={showMarkdown ? 'Edit' : 'Preview markdown'}
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>
        </button>
      {/if}
      <div class="relative">
        <button
          onclick={() => showColorPicker = !showColorPicker}
          class="p-2 rounded-full hover:bg-black/10 text-on-surface-muted hover:text-on-surface transition-colors"
          title="Change color"
          aria-label="Change color"
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
        class="p-2 rounded-full hover:bg-black/10 text-on-surface-muted hover:text-on-surface transition-colors"
        title={note.pinned ? 'Unpin' : 'Pin'}
        aria-label={note.pinned ? 'Unpin' : 'Pin'}
      >
        <PinIcon filled={note.pinned} />
      </button>
      <div class="relative">
        <button
          bind:this={shareButtonEl}
          onclick={() => void handleShare()}
          class="p-2 rounded-full hover:bg-black/10 text-on-surface-muted hover:text-on-surface transition-colors {showShareMenu ? 'bg-black/10' : ''}"
          title="Share note"
          aria-label="Share note"
          aria-haspopup="menu"
          aria-expanded={showShareMenu}
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z"/></svg>
        </button>
        {#if showShareMenu}
          <div
            bind:this={shareMenuEl}
            class="absolute bottom-full right-0 z-30 mb-2 w-64 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-border bg-surface text-on-surface shadow-xl"
            role="menu"
            aria-label="Share note options"
          >
            <div class="border-b border-border bg-surface-dim px-3 py-2.5">
              <p class="text-sm font-medium">Send a Markdown copy</p>
              <p class="mt-0.5 text-xs text-on-surface-muted">The destination receives plaintext.</p>
            </div>
            <div class="grid p-1.5 text-sm">
              <button
                type="button"
                role="menuitem"
                class="rounded-lg px-3 py-2 text-left hover:bg-surface-dim focus:bg-surface-dim"
                onclick={() => void handleOpenInObsidian()}
              >Open in Obsidian</button>
              <button
                type="button"
                role="menuitem"
                class="rounded-lg px-3 py-2 text-left hover:bg-surface-dim focus:bg-surface-dim"
                onclick={() => void copyShareValue(noteToShareMarkdown(note), 'Markdown copied')}
              >Copy as Markdown</button>
              <button
                type="button"
                role="menuitem"
                class="rounded-lg px-3 py-2 text-left hover:bg-surface-dim focus:bg-surface-dim"
                onclick={() => void copyShareValue(noteToShareText(note), 'Plain text copied')}
              >Copy as plain text</button>
              <button
                type="button"
                role="menuitem"
                class="rounded-lg px-3 py-2 text-left hover:bg-surface-dim focus:bg-surface-dim"
                onclick={handleDownloadMarkdown}
              >Download .md</button>
              <div class="my-1 border-t border-border"></div>
              <button
                type="button"
                role="menuitem"
                class="rounded-lg px-3 py-2 text-left text-on-surface-muted hover:bg-surface-dim focus:bg-surface-dim"
                onclick={() => void handleQuickSend()}
              >Copy unencrypted Quick Send link</button>
            </div>
          </div>
        {/if}
      </div>
      <button
        type="button"
        onclick={handleDelete}
        disabled={deleting}
        class="p-2 rounded-full hover:bg-black/10 text-danger transition-colors"
        title="Delete"
        aria-label="Delete"
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
      </button>
      {/if}
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
