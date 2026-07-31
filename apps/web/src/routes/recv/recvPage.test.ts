import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

describe('Quick Send receive route', () => {
  it('unlocks and initializes the vault before reporting a durable save', () => {
    expect(source).toContain('<AuthVaultGate');
    expect(source).toContain('await noteStore.init(vault.ownerId, vault.migrateLegacy)');
    expect(source).toContain('await noteStore.createReceivedNote(received)');
    expect(source).not.toMatch(/noteStore\.createNote\(content\)/);
  });

  it('uses the structured, backward-compatible decoder', () => {
    expect(source).toContain('decodeQuickSendNote(hash)');
    expect(source).toContain('received.checkboxes');
    expect(source).toContain('received.title');
  });

  it('removes the unencrypted bearer payload from browser history immediately', () => {
    expect(source).toContain("history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)");
    expect(source.indexOf('history.replaceState')).toBeLessThan(source.indexOf('decodeQuickSendNote(hash)'));
    expect(source).toContain('Quick Send links do not expire and cannot be revoked');
  });
});
