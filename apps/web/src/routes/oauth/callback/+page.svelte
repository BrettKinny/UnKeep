<script lang="ts">
  import { onMount } from 'svelte';

  let status = $state<'processing' | 'done' | 'error'>('processing');
  let errorMessage = $state('');

  onMount(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const state = params.get('state');
    const error = params.get('error');
    const errorDesc = params.get('error_description');

    if (error) {
      status = 'error';
      errorMessage = errorDesc || error;
      window.opener?.postMessage(
        { type: 'unkeep-oauth-callback', error: errorMessage },
        window.location.origin,
      );
      return;
    }

    if (!code || !state) {
      status = 'error';
      errorMessage = 'Missing authorization code or state parameter.';
      window.opener?.postMessage(
        { type: 'unkeep-oauth-callback', error: errorMessage },
        window.location.origin,
      );
      return;
    }

    // Post the authorization code back to the opener window
    window.opener?.postMessage(
      { type: 'unkeep-oauth-callback', code, state },
      window.location.origin,
    );

    status = 'done';

    // Close the popup after a brief delay
    setTimeout(() => window.close(), 1500);
  });
</script>

<div class="min-h-screen bg-surface flex items-center justify-center p-4">
  <div class="text-center">
    {#if status === 'processing'}
      <svg class="w-8 h-8 animate-spin text-primary mx-auto mb-4" fill="none" viewBox="0 0 24 24">
        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/>
        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
      </svg>
      <p class="text-on-surface-muted">Completing authorization...</p>
    {:else if status === 'done'}
      <svg class="w-10 h-10 text-primary mx-auto mb-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/>
      </svg>
      <p class="text-on-surface">Authorization complete! This window will close.</p>
    {:else}
      <svg class="w-10 h-10 text-danger mx-auto mb-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
      </svg>
      <p class="text-danger mb-2">Authorization failed</p>
      <p class="text-on-surface-muted text-sm">{errorMessage}</p>
      <button onclick={() => window.close()} class="mt-4 px-4 py-2 bg-surface-dim text-on-surface rounded hover:bg-border text-sm">
        Close
      </button>
    {/if}
  </div>
</div>
