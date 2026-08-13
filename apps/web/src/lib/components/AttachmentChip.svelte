<script lang="ts">
  import type { NoteAttachment } from '@unkeep/core';
  import { formatAttachmentSize, hasLocalAttachmentUrl } from '$lib/attachments';

  let {
    attachment,
    onRemove,
  }: {
    attachment: NoteAttachment;
    onRemove?: () => void;
  } = $props();
</script>

<div class="flex min-w-0 items-stretch rounded-lg border border-border/60 bg-black/5 text-sm">
  {#if hasLocalAttachmentUrl(attachment)}
    <!-- A locally minted blob URL is not an application route. -->
    <!-- eslint-disable svelte/no-navigation-without-resolve -->
    <a
      href={attachment.url}
      download={attachment.name}
      onclick={(event) => event.stopPropagation()}
      class="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2.5 py-2 text-on-surface hover:bg-black/10"
      title={`Download ${attachment.name}`}
    >
      <svg class="h-4 w-4 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14"/></svg>
      <span class="min-w-0 flex-1 truncate">{attachment.name}</span>
      <span class="shrink-0 text-xs text-on-surface-muted">{formatAttachmentSize(attachment.size)}</span>
    </a>
    <!-- eslint-enable svelte/no-navigation-without-resolve -->
  {:else}
    <span
      class="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-on-surface-muted"
      title={`${attachment.name} is not available on this device`}
    >
      <svg class="h-4 w-4 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V6m-4-4l4 4m-4-4v4h4"/></svg>
      <span class="min-w-0 flex-1 truncate">{attachment.name}</span>
      <span class="shrink-0 text-xs">{formatAttachmentSize(attachment.size)}</span>
    </span>
  {/if}
  {#if onRemove}
    <button
      type="button"
      class="grid w-9 shrink-0 place-items-center rounded-r-lg text-on-surface-muted hover:bg-black/10 hover:text-danger"
      aria-label={`Remove ${attachment.name}`}
      title={`Remove ${attachment.name}`}
      onclick={(event) => { event.stopPropagation(); onRemove?.(); }}
    >
      <svg class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 18L18 6M6 6l12 12"/></svg>
    </button>
  {/if}
</div>
