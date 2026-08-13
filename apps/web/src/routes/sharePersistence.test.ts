import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

describe('pending share persistence', () => {
  it('saves each share durably before acknowledging its queue entry', () => {
    const save = source.indexOf('await noteStore.createReceivedNote');
    const acknowledge = source.indexOf('savedIds.push(share.id)');
    const remove = source.indexOf('removePendingShares(savedIds)');

    expect(save).toBeGreaterThan(-1);
    expect(acknowledge).toBeGreaterThan(save);
    expect(remove).toBeGreaterThan(acknowledge);
    expect(source).toContain('idempotencyKey: share.id');
    expect(source).toContain('createdAt: share.createdAt');
    expect(source).not.toContain('noteStore.createNote(share.text');
  });

  it('never drains a share bound to a different vault', () => {
    expect(source).toContain('share.targetInstanceId === vault.session.instanceId');
    expect(source).toContain('share.targetInstanceId === null');
    expect(source).toContain('window.confirm(');
    expect(source).toContain('belongs to another vault');
  });
});
