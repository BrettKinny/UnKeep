<script lang="ts">
  import type { NoteColor } from '@unkeep/core';

  let { selected, onSelect }: { selected: NoteColor; onSelect: (color: NoteColor) => void } = $props();

  const colors: { name: NoteColor; css: string }[] = [
    { name: 'default', css: 'var(--color-note-default)' },
    { name: 'red', css: 'var(--color-note-red)' },
    { name: 'orange', css: 'var(--color-note-orange)' },
    { name: 'yellow', css: 'var(--color-note-yellow)' },
    { name: 'green', css: 'var(--color-note-green)' },
    { name: 'teal', css: 'var(--color-note-teal)' },
    { name: 'blue', css: 'var(--color-note-blue)' },
    { name: 'purple', css: 'var(--color-note-purple)' },
    { name: 'pink', css: 'var(--color-note-pink)' },
    { name: 'brown', css: 'var(--color-note-brown)' },
    { name: 'gray', css: 'var(--color-note-gray)' },
  ];
</script>

<div class="bg-surface border border-border rounded-lg shadow-lg p-2 flex gap-1 flex-wrap w-48">
  {#each colors as color}
    <button
      onclick={() => onSelect(color.name)}
      class="w-7 h-7 rounded-full border-2 transition-transform hover:scale-110"
      class:border-primary={selected === color.name}
      class:border-transparent={selected !== color.name}
      style="background-color: {color.css}"
      title={color.name}
      aria-label="Set color to {color.name}"
    ></button>
  {/each}
</div>
