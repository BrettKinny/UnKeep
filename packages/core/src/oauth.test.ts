import { describe, it, expect } from 'vitest';
import { generateCodeVerifier, generateCodeChallenge, generateState } from './oauth.js';

describe('generateCodeVerifier', () => {
  it('generates a string of the requested length', () => {
    const verifier = generateCodeVerifier(64);
    expect(verifier).toHaveLength(64);
  });

  it('generates only URL-safe characters', () => {
    const verifier = generateCodeVerifier(128);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('generates unique values', () => {
    const a = generateCodeVerifier();
    const b = generateCodeVerifier();
    expect(a).not.toBe(b);
  });

  it('defaults to 64 characters', () => {
    const verifier = generateCodeVerifier();
    expect(verifier).toHaveLength(64);
  });
});

describe('generateCodeChallenge', () => {
  it('produces a base64url-encoded SHA-256 hash', async () => {
    const challenge = await generateCodeChallenge('test_verifier');
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    // SHA-256 produces 32 bytes = 43 base64url chars (no padding)
    expect(challenge).toHaveLength(43);
  });

  it('produces deterministic output for same input', async () => {
    const a = await generateCodeChallenge('same_input');
    const b = await generateCodeChallenge('same_input');
    expect(a).toBe(b);
  });

  it('produces different output for different inputs', async () => {
    const a = await generateCodeChallenge('input_a');
    const b = await generateCodeChallenge('input_b');
    expect(a).not.toBe(b);
  });
});

describe('generateState', () => {
  it('generates a non-empty string', () => {
    const state = generateState();
    expect(state.length).toBeGreaterThan(0);
  });

  it('generates only URL-safe characters', () => {
    const state = generateState();
    expect(state).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('generates unique values', () => {
    const a = generateState();
    const b = generateState();
    expect(a).not.toBe(b);
  });
});
