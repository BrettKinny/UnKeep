<script lang="ts">
  let { filled = false, class: className = 'w-4 h-4' }: {
    filled?: boolean;
    class?: string;
  } = $props();
</script>

<svg
  class={className}
  fill={filled ? 'currentColor' : 'none'}
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
  viewBox="0 0 24 24"
  aria-hidden="true"
>
  <path d="M9 3h6v7l2 4v2H7v-2l2-4V3z" />
  <path d="M12 16v5" />
</svg>
