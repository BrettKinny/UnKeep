<script lang="ts">
  import type { StorageAdapter, ConfigField } from '@unkeep/core';
  import { adapters, getAdapter } from '$lib/adapterRegistry';
  import { saveConfig } from '$lib/adapterConfig';
  import { noteStore } from '$lib/noteStore.svelte';

  let { onComplete }: { onComplete: () => void } = $props();

  let step = $state<'pick' | 'configure' | 'validating' | 'done'>('pick');
  let selectedId = $state<string | null>(null);
  let selectedAdapter = $state<StorageAdapter | null>(null);
  let configValues = $state<Record<string, string>>({});
  let validationError = $state<string | null>(null);

  function pickAdapter(id: string) {
    selectedId = id;
    selectedAdapter = getAdapter(id);
    configValues = {};
    // Pre-fill defaults
    for (const field of selectedAdapter.configSchema) {
      configValues[field.key] = '';
    }
    if (selectedAdapter.configSchema.length === 0) {
      // No config needed (e.g. LocalOnlyAdapter) — skip to done
      handleFinish();
    } else {
      step = 'configure';
    }
  }

  async function handleValidate() {
    if (!selectedAdapter || !selectedId) return;
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
  }
</script>

<div class="min-h-screen bg-surface flex items-center justify-center p-4">
  <div class="w-full max-w-lg">
    <!-- Logo -->
    <div class="text-center mb-8">
      <h1 class="text-3xl font-bold text-on-surface">UnKeep</h1>
      <p class="text-on-surface-muted mt-2">Your notes. Your storage. Not Google's.</p>
    </div>

    {#if step === 'pick'}
      <div class="space-y-3">
        <h2 class="text-lg font-medium text-on-surface mb-4">Choose where to store your notes</h2>
        {#each adapters as entry}
          {@const adapter = getAdapter(entry.id)}
          <button
            onclick={() => pickAdapter(entry.id)}
            class="w-full text-left p-4 rounded-lg border border-border hover:border-primary hover:bg-surface-dim transition-colors"
          >
            <div class="font-medium text-on-surface">{adapter.displayName}</div>
            <div class="text-sm text-on-surface-muted mt-1">{adapter.description}</div>
          </button>
        {/each}
      </div>

    {:else if step === 'configure' || step === 'validating'}
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
            {#each selectedAdapter.configSchema as field}
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
          {/if}

          <button
            type="submit"
            disabled={step === 'validating'}
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
