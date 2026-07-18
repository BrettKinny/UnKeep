import { describe, expect, it } from 'vitest';
import { cleanRelayEndpoint, RelayClient } from './relay.js';

describe('cleanRelayEndpoint', () => {
  it.each([
    ['https://public.example.com/sync', 'https://public.example.com'],
    ['https://8.8.8.8:8443/path', 'https://8.8.8.8:8443'],
    ['http://localhost:3000/api/v1', 'http://localhost:3000'],
    ['http://127.0.0.1:3000', 'http://127.0.0.1:3000'],
    ['http://127.42.0.1', 'http://127.42.0.1'],
    ['http://[::1]:3000', 'http://[::1]:3000'],
    ['http://10.0.0.1', 'http://10.0.0.1'],
    ['http://10.255.255.255', 'http://10.255.255.255'],
    ['http://172.16.0.1', 'http://172.16.0.1'],
    ['http://172.31.255.255', 'http://172.31.255.255'],
    ['http://192.168.0.1', 'http://192.168.0.1'],
    ['http://unkeep:3000/api/v1', 'http://unkeep:3000'],
    ['http://unkeep.internal:3000', 'http://unkeep.internal:3000'],
    ['http://relay.prod.internal', 'http://relay.prod.internal'],
  ])('accepts %s', (endpoint, origin) => {
    expect(cleanRelayEndpoint(endpoint)).toBe(origin);
  });

  it.each([
    'http://public.example.com',
    'http://8.8.8.8',
    'http://172.15.255.255',
    'http://172.32.0.1',
    'http://192.167.255.255',
    'http://192.169.0.1',
    'http://[2001:4860:4860::8888]',
    'http://unkeep.local',
  ])('rejects unsafe plain HTTP endpoint %s with override guidance', endpoint => {
    expect(() => cleanRelayEndpoint(endpoint)).toThrow(/allowInsecure: true/);
  });

  it('allows an unsafe plain HTTP endpoint with an explicit override', () => {
    expect(cleanRelayEndpoint('http://public.example.com/path', { allowInsecure: true })).toBe('http://public.example.com');
    expect(new RelayClient('http://public.example.com/path', { allowInsecure: true }).endpoint).toBe('http://public.example.com');
    expect(new RelayClient('http://public.example.com/path', 'credential', { allowInsecure: true }).endpoint).toBe('http://public.example.com');
  });

  it('rejects unsupported protocols even with the insecure override', () => {
    expect(() => cleanRelayEndpoint('ftp://unkeep', { allowInsecure: true })).toThrow(/HTTP or HTTPS/);
  });
});
