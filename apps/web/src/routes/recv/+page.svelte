<script lang="ts">
  import { onMount } from 'svelte';
  import { decodeQuickSendNote, type QuickSendNote } from '$lib/quickSend';
  import { noteStore } from '$lib/noteStore.svelte';
  import { toastStore } from '$lib/toast.svelte';
  import AuthVaultGate, { type VaultReady } from '$lib/components/AuthVaultGate.svelte';
  import Toast from '$lib/components/Toast.svelte';
  import LinkedText from '$lib/components/LinkedText.svelte';

  let received = $state<QuickSendNote | null>(null);
  let error = $state('');
  let saved = $state(false);
  let saving = $state(false);
  let saveRequested = $state(false);
  let vaultReady = $state(false);

  onMount(async () => {
    const hash = window.location.hash.slice(1);
    // Quick Send is an unencrypted bearer snapshot. Remove it from the visible
    // URL and browser history as soon as this page has captured the payload.
    history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    if (!hash) {
      error = 'No note data found in the URL.';
      return;
    }
    try {
      received = await decodeQuickSendNote(hash);
    } catch (e) {
      error = `Failed to decode note: ${e}`;
    }
  });

  async function handleCopy() {
    if (!received) return;
    const text = received.checkboxes?.length
      ? received.checkboxes.map(item => `${item.checked ? '☑' : '☐'} ${item.text}`).join('\n')
      : received.content;
    await navigator.clipboard.writeText([received.title, text].filter(Boolean).join('\n\n'));
    toastStore.show('Copied to clipboard');
  }

  async function persistReceivedNote() {
    if (!received || saved || saving) return;
    saving = true;
    error = '';
    try {
      await noteStore.createReceivedNote(received);
      saved = true;
      toastStore.show('Note saved!');
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      saving = false;
    }
  }

  function handleSave() {
    saveRequested = true;
    if (vaultReady) void persistReceivedNote();
  }

  async function handleVaultReady(vault: VaultReady) {
    await noteStore.init(vault.ownerId, vault.migrateLegacy);
    await noteStore.enableEncryptedSync(vault.session, vault.masterKey);
    vaultReady = true;
    if (saveRequested) await persistReceivedNote();
  }
</script>

{#if saveRequested}
  <AuthVaultGate
    onReady={handleVaultReady}
    onSignedOut={async () => {
      await noteStore.disableEncryptedSync();
      vaultReady = false;
      saveRequested = false;
    }}
  />
{/if}

<main class="min-h-screen bg-surface flex items-center justify-center p-4">
  <div class="w-full max-w-lg">
    <div class="text-center mb-6">
      <img src="/icon.svg" alt="UnKeep" class="w-12 h-12 mx-auto mb-2" />
      <h1 class="text-2xl font-bold text-on-surface">UnKeep</h1>
      <p class="text-on-surface-muted text-sm mt-1">Received note</p>
    </div>

    {#if error && !received}
      <div class="bg-danger/10 border border-danger/30 text-danger rounded-lg p-4 text-center">
        {error}
      </div>
    {:else if received}
      <div class="bg-surface-dim rounded-lg p-4 border border-border">
        {#if received.title}<h2 class="mb-3 text-lg font-semibold text-on-surface"><LinkedText text={received.title} /></h2>{/if}
        {#if received.checkboxes?.length}
          <ul class="grid gap-2 text-sm text-on-surface">
            {#each received.checkboxes as item}
              <li class:line-through={item.checked} class:text-on-surface-muted={item.checked}>
                <span aria-hidden="true">{item.checked ? '☑' : '☐'}</span> <LinkedText text={item.text} />
              </li>
            {/each}
          </ul>
        {:else if received.content}
          <pre class="whitespace-pre-wrap text-on-surface text-sm font-mono"><LinkedText text={received.content} /></pre>
        {/if}
        {#if received.labels?.length}
          <div class="mt-3 flex flex-wrap gap-1">
            {#each received.labels as label}<span class="rounded-full bg-surface px-2 py-0.5 text-xs text-on-surface-muted">{label}</span>{/each}
          </div>
        {/if}
        {#if received.attachments?.length}
          <div class="mt-3 border-t border-border pt-3 text-xs text-on-surface-muted">
            {received.attachments.length} attachment{received.attachments.length === 1 ? '' : 's'}:
            {received.attachments.map(attachment => attachment.name).join(', ')}
          </div>
        {/if}
      </div>

      {#if error}
        <p class="mt-3 rounded-lg border border-danger/30 bg-danger/10 p-3 text-sm text-danger" role="alert">{error}</p>
      {/if}

      <div class="flex gap-3 mt-4">
        <button
          onclick={() => void handleCopy()}
          class="flex-1 py-2.5 border border-border rounded-lg text-on-surface hover:bg-surface-dim transition-colors"
        >
          Copy to clipboard
        </button>
        {#if !saved}
          <button
            onclick={handleSave}
            disabled={saving}
            class="flex-1 py-2.5 bg-primary text-on-primary rounded-lg font-medium hover:bg-primary-dim transition-colors"
          >
            {saving ? 'Saving…' : saveRequested && !vaultReady ? 'Unlocking…' : 'Save to UnKeep'}
          </button>
        {:else}
          <div class="flex-1 py-2.5 text-center text-green-500 font-medium">
            Saved!
          </div>
        {/if}
      </div>

      <p class="text-xs text-on-surface-muted text-center mt-4">
        This was an unencrypted bearer link: anyone who received the original URL could read it.
        Quick Send links do not expire and cannot be revoked.
      </p>
    {:else}
      <div class="text-center py-8">
        <svg class="w-8 h-8 mx-auto animate-spin text-primary" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
        <p class="mt-3 text-on-surface-muted">Decoding note...</p>
      </div>
    {/if}
  </div>
</main>

<Toast />
