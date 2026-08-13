import { describe, expect, it } from 'vitest';
import { MemoryClientStorage } from './storage.js';

describe('MemoryClientStorage transactions', () => {
  it('commits related key changes as one operation', async () => {
    const storage = new MemoryClientStorage();
    await storage.set('removed', 'old');

    await storage.transact(['first', 'second', 'removed'], transaction => {
      transaction.set('first', { value: 1 });
      transaction.set('second', { value: 2 });
      transaction.delete('removed');
    });

    await expect(storage.get('first')).resolves.toEqual({ value: 1 });
    await expect(storage.get('second')).resolves.toEqual({ value: 2 });
    await expect(storage.get('removed')).resolves.toBeNull();
  });

  it('rolls every key back when the transaction callback fails', async () => {
    const storage = new MemoryClientStorage();
    await storage.set('first', { value: 1 });
    await storage.set('second', { value: 2 });

    await expect(storage.transact(['first', 'second'], transaction => {
      transaction.set('first', { value: 9 });
      transaction.delete('second');
      throw new Error('abort transaction');
    })).rejects.toThrow('abort transaction');

    await expect(storage.get('first')).resolves.toEqual({ value: 1 });
    await expect(storage.get('second')).resolves.toEqual({ value: 2 });
  });
});
