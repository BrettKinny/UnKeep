<script lang="ts">
  import '../app.css';
  import InsecureContextNotice from '$lib/components/InsecureContextNotice.svelte';

  let { children } = $props();
</script>

{#if window.isSecureContext}
  {@render children()}
{:else}
  <InsecureContextNotice />
{/if}
