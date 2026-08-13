import { describe, it, expect, beforeEach } from 'vitest';
import { getSavedConfig, saveConfig, clearConfig } from './adapterConfig.js';

// Simple localStorage mock for Node
const store: Record<string, string> = {};
const localStorageMock = {
  getItem: (key: string) => store[key] ?? null,
  setItem: (key: string, value: string) => { store[key] = value; },
  removeItem: (key: string) => { delete store[key]; },
};

Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true });

describe('adapterConfig', () => {
  beforeEach(() => {
    for (const key of Object.keys(store)) delete store[key];
  });

  it('returns null when no config saved', () => {
    expect(getSavedConfig()).toBeNull();
  });

  it('saves and retrieves config', () => {
    saveConfig('git', { token: 'abc', repo: 'notes' });
    const saved = getSavedConfig();
    expect(saved).toEqual({
      adapterId: 'git',
      config: { token: 'abc', repo: 'notes' },
    });
  });

  it('clears config', () => {
    saveConfig('local', {});
    clearConfig();
    expect(getSavedConfig()).toBeNull();
  });

  it('overwrites previous config', () => {
    saveConfig('local', {});
    saveConfig('s3', { bucket: 'test' });
    const saved = getSavedConfig();
    expect(saved?.adapterId).toBe('s3');
  });

  it('handles corrupted localStorage gracefully', () => {
    store['unkeep-adapter-config'] = '{invalid json';
    expect(getSavedConfig()).toBeNull();
  });
});
