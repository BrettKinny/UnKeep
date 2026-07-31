<script lang="ts">
  import type { StorageAdapter } from '@unkeep/core/experimental';
  import { adapters, getAdapter } from '$lib/adapterRegistry';
  import { saveConfig } from '$lib/adapterConfig';
  import { noteStore } from '$lib/noteStore.svelte';
  import {
    startOAuthPopup,
    exchangeCodeForTokens,
    saveTokens,
    getRedirectUri,
  } from '$lib/oauth';

  let { onComplete }: { onComplete: () => void } = $props();

  let step = $state<'pick' | 'configure' | 'validating' | 'authorizing' | 'done'>('pick');
  let selectedId = $state<string | null>(null);
  let selectedAdapter = $state<StorageAdapter | null>(null);
  let configValues = $state<Record<string, string>>({});
  let validationError = $state<string | null>(null);
  let oauthComplete = $state(false);

  /** Config fields that the user fills in (excludes accessToken — handled by OAuth). */
  let visibleConfigFields = $derived.by(() => {
    if (!selectedAdapter) return [];
    if (selectedAdapter.oauthConfig) {
      // Hide accessToken field if present — it comes from OAuth
      return selectedAdapter.configSchema.filter(f => f.key !== 'accessToken');
    }
    return selectedAdapter.configSchema;
  });

  /** Whether the current adapter uses OAuth. */
  let usesOAuth = $derived(!!selectedAdapter?.oauthConfig);

  async function pickAdapter(id: string) {
    selectedId = id;
    selectedAdapter = await getAdapter(id);
    configValues = {};
    oauthComplete = false;
    for (const field of selectedAdapter.configSchema) {
      configValues[field.key] = '';
    }
    if (selectedAdapter.configSchema.length === 0 && !selectedAdapter.oauthConfig) {
      // No config needed (e.g. LocalOnlyAdapter) — skip to done
      handleFinish();
    } else {
      step = 'configure';
    }
  }

  async function handleAuthorize() {
    if (!selectedAdapter?.oauthConfig || !selectedId) return;
    validationError = null;
    step = 'authorizing';

    const clientId = configValues.clientId;
    if (!clientId) {
      validationError = 'Client ID is required to start authorization.';
      step = 'configure';
      return;
    }

    try {
      const flowParams = {
        oauthConfig: selectedAdapter.oauthConfig,
        clientId,
        clientSecret: configValues.clientSecret || undefined,
        redirectUri: getRedirectUri(),
      };

      const code = await startOAuthPopup(flowParams);
      const tokens = await exchangeCodeForTokens(flowParams, code);

      // Inject the access token into config
      configValues.accessToken = tokens.accessToken;
      oauthComplete = true;

      // Persist tokens for refresh later
      saveTokens(selectedId, tokens);

      step = 'configure';
    } catch (e) {
      validationError = `Authorization failed: ${e instanceof Error ? e.message : e}`;
      step = 'configure';
    }
  }

  async function handleValidate() {
    if (!selectedAdapter || !selectedId) return;

    // For OAuth adapters, ensure authorization happened
    if (usesOAuth && !oauthComplete) {
      validationError = 'Please authorize with your cloud provider first.';
      return;
    }

    step = 'validating';
    validationError = null;

    const result = await selectedAdapter.validate(configValues);
    if (result.valid) {
      await handleFinish();
    } else {
      validationError = result.error || 'Validation failed';
      step = 'configure';
    }
  }

  async function handleFinish() {
    if (!selectedAdapter || !selectedId) return;
    saveConfig(selectedId, configValues);
    await noteStore.initWithAdapter(selectedAdapter, configValues);
    step = 'done';
    onComplete();
  }

  function goBack() {
    step = 'pick';
    selectedId = null;
    selectedAdapter = null;
    validationError = null;
    oauthComplete = false;
  }
</script>

<div class="min-h-screen bg-surface flex items-center justify-center p-4">
  <div class="w-full max-w-lg">
    <!-- Logo -->
    <div class="text-center mb-8">
      <img src="/icon.svg" alt="UnKeep" class="w-16 h-16 mx-auto mb-3" />
      <h1 class="text-3xl font-bold text-on-surface">UnKeep</h1>
      <p class="text-on-surface-muted mt-2">Your notes. Your storage.</p>
    </div>

    {#if step === 'pick'}
      <div class="space-y-3">
        <h2 class="text-lg font-medium text-on-surface mb-4">Choose where to store your notes</h2>
        {#each adapters as entry}
          <button
            onclick={() => pickAdapter(entry.id)}
            class="w-full text-left p-4 rounded-lg border border-border hover:border-primary hover:bg-surface-dim transition-colors"
          >
            <div class="font-medium text-on-surface">{entry.displayName}</div>
            <div class="text-sm text-on-surface-muted mt-1">{entry.description}</div>
          </button>
        {/each}
      </div>

    {:else if step === 'configure' || step === 'validating' || step === 'authorizing'}
      <div>
        <button onclick={goBack} class="text-sm text-on-surface-muted hover:text-on-surface mb-4 flex items-center gap-1">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M15 19l-7-7 7-7"/></svg>
          Back
        </button>
        <h2 class="text-lg font-medium text-on-surface mb-4">
          Configure {selectedAdapter?.displayName}
        </h2>

        {#if validationError}
          <div class="bg-danger/10 border border-danger/30 text-danger rounded-lg p-3 mb-4 text-sm">
            {validationError}
          </div>
        {/if}

        <form onsubmit={(e) => { e.preventDefault(); handleValidate(); }} class="space-y-4">
          {#if selectedAdapter}
            <!-- Regular config fields -->
            {#each visibleConfigFields as field}
              <div>
                <label for={field.key} class="block text-sm font-medium text-on-surface mb-1">
                  {field.label}
                  {#if field.required}<span class="text-danger">*</span>{/if}
                </label>
                <input
                  id={field.key}
                  type={field.type === 'password' ? 'password' : 'text'}
                  placeholder={field.placeholder}
                  bind:value={configValues[field.key]}
                  required={field.required}
                  class="w-full px-3 py-2 bg-surface-dim border border-border rounded-lg text-on-surface placeholder:text-on-surface-muted outline-none focus:border-primary transition-colors"
                />
                {#if field.helpText}
                  <p class="text-xs text-on-surface-muted mt-1">{field.helpText}</p>
                {/if}
              </div>
            {/each}

            <!-- OAuth authorize button -->
            {#if usesOAuth}
              <div class="pt-2">
                {#if oauthComplete}
                  <div class="flex items-center gap-2 p-3 bg-green-500/10 border border-green-500/30 rounded-lg text-sm text-green-400">
                    <svg class="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/>
                    </svg>
                    Authorized successfully
                  </div>
                {:else}
                  <button
                    type="button"
                    onclick={handleAuthorize}
                    disabled={step === 'authorizing'}
                    class="w-full py-2.5 bg-surface-dim border border-border text-on-surface rounded-lg font-medium hover:border-primary hover:bg-surface transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                  >
                    {#if step === 'authorizing'}
                      <svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
                      Waiting for authorization...
                    {:else}
                      <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4M10 17l5-5-5-5M15 12H3"/></svg>
                      Sign in with {selectedAdapter.displayName}
                    {/if}
                  </button>
                  <p class="text-xs text-on-surface-muted mt-1">Opens a popup to authorize with your account. Make sure popups are allowed.</p>
                {/if}
              </div>
            {/if}
          {/if}

          <button
            type="submit"
            disabled={step === 'validating' || step === 'authorizing' || (usesOAuth && !oauthComplete)}
            class="w-full py-2.5 bg-primary text-on-primary rounded-lg font-medium hover:bg-primary-dim transition-colors disabled:opacity-50"
          >
            {#if step === 'validating'}
              <span class="flex items-center justify-center gap-2">
                <svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
                Validating...
              </span>
            {:else}
              Connect
            {/if}
          </button>
        </form>
      </div>
    {/if}
  </div>
</div>
