<script lang="ts">
  import { linkify } from '$lib/linkify';

  let { text }: { text: string } = $props();

  let segments = $derived(linkify(text));

  // A note card opens the editor on click/Enter — following a link must not also open it.
  function stopActivation(event: MouseEvent | KeyboardEvent) {
    if (event instanceof KeyboardEvent && event.key !== 'Enter') return;
    event.stopPropagation();
  }
</script>

<!-- Rendered on one line: any whitespace between the segments would show up in the note text. -->
<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- hrefs are external http/https/mailto links from note text, never app routes -->
{#each segments as segment}{#if segment.type === 'link'}<a href={segment.href} target="_blank" rel="noopener noreferrer" class="text-primary underline decoration-primary/50 hover:decoration-primary break-words" onclick={stopActivation} onkeydown={stopActivation}>{segment.value}</a>{:else}{segment.value}{/if}{/each}
