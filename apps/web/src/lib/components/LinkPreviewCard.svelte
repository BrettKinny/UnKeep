<script lang="ts">
  import type { LinkPreview } from '@unkeep/client';

  let {
    url,
    preview,
    variant = 'card',
  }: {
    url: string;
    preview: LinkPreview;
    /** `card` bleeds to a note card's edges; `editor` is a bordered row. */
    variant?: 'card' | 'editor';
  } = $props();

  let imageFailed = $state(false);
  let host = $derived.by(() => {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return url;
    }
  });

  // The card opens the editor on click/Enter; following the link must not.
  function stopActivation(event: MouseEvent | KeyboardEvent) {
    if (event instanceof KeyboardEvent && event.key !== 'Enter') return;
    event.stopPropagation();
  }
</script>

<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external http(s) link from note text, never an app route -->
<a href={url}
  target="_blank"
  rel="noopener noreferrer"
  class="pointer-events-auto relative flex min-h-20 items-stretch overflow-hidden {variant === 'card' ? '-mx-3 border-t' : 'rounded-lg border'} border-border/50 bg-black/5 text-on-surface transition-colors hover:bg-black/10 dark:bg-white/5 dark:hover:bg-white/10"
  aria-label={`Open link: ${preview.title ?? host}`}
  onclick={stopActivation}
  onkeydown={stopActivation}
>
  {#if preview.imageUrl && !imageFailed}
    <img
      src={preview.imageUrl}
      alt=""
      loading="lazy"
      decoding="async"
      referrerpolicy="no-referrer"
      class="w-22 shrink-0 bg-black/10 object-cover"
      onerror={() => imageFailed = true}
    />
  {/if}
  <span class="flex min-w-0 flex-1 flex-col justify-center gap-0.5 py-2 pl-3 pr-7">
    <span class="line-clamp-2 text-sm font-medium">{preview.title ?? host}</span>
    <span class="truncate text-xs text-on-surface-muted">{host}</span>
  </span>
  <svg class="absolute right-2 top-2 h-3.5 w-3.5 text-on-surface-muted" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5"/></svg>
</a>
