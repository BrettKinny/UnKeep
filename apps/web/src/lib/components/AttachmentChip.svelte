<script lang="ts">
  import type { NoteAttachment } from '@unkeep/core';
  import { formatAttachmentSize } from '$lib/attachments';

  let { attachment }: { attachment: NoteAttachment } = $props();
</script>

{#if attachment.url}
  <!-- A decrypted blob/data URL is not an application route. -->
  <!-- eslint-disable svelte/no-navigation-without-resolve -->
  <a
    href={attachment.url}
    download={attachment.name}
    onclick={(event) => event.stopPropagation()}
    class="flex min-w-0 items-center gap-2 rounded-lg border border-border/60 bg-black/5 px-2.5 py-2 text-sm text-on-surface hover:bg-black/10"
    title={`Download ${attachment.name}`}
  >
    <svg class="h-4 w-4 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14"/></svg>
    <span class="min-w-0 flex-1 truncate">{attachment.name}</span>
    <span class="shrink-0 text-xs text-on-surface-muted">{formatAttachmentSize(attachment.size)}</span>
  </a>
  <!-- eslint-enable svelte/no-navigation-without-resolve -->
{:else}
  <span
    class="flex min-w-0 items-center gap-2 rounded-lg border border-border/60 bg-black/5 px-2.5 py-2 text-sm text-on-surface-muted"
    title={`${attachment.name} is not available on this device`}
  >
    <svg class="h-4 w-4 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V6m-4-4l4 4m-4-4v4h4"/></svg>
    <span class="min-w-0 flex-1 truncate">{attachment.name}</span>
    <span class="shrink-0 text-xs">{formatAttachmentSize(attachment.size)}</span>
  </span>
{/if}
