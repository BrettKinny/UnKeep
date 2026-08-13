import { homedir } from 'node:os';
import { join } from 'node:path';
import type { RelaySession } from '@unkeep/client';

export interface ConfigFlags {
  endpoint?: string;
  credential?: string;
  vaultKey?: string;
}

export interface FileConfiguration {
  endpoint?: unknown;
  credential?: unknown;
  vaultKey?: unknown;
  vault_key?: unknown;
  'unkeep-relay-session'?: unknown;
}

export interface ResolvedConfiguration {
  endpoint?: string;
  credential?: string;
  vaultKey?: string;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function storedSession(file: FileConfiguration): RelaySession | undefined {
  const value = file['unkeep-relay-session'];
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<RelaySession>;
  if (!nonEmpty(candidate.endpoint) || !nonEmpty(candidate.credential)) return undefined;
  return candidate as RelaySession;
}

/** Resolve connection values in the documented flags > environment > file order. */
export function resolveConfiguration(
  flags: ConfigFlags,
  environment: Record<string, string | undefined>,
  file: FileConfiguration,
): ResolvedConfiguration {
  const session = storedSession(file);
  return {
    endpoint: nonEmpty(flags.endpoint) ?? nonEmpty(environment.UNKEEP_ENDPOINT) ?? nonEmpty(file.endpoint) ?? nonEmpty(session?.endpoint),
    credential: nonEmpty(flags.credential) ?? nonEmpty(environment.UNKEEP_CREDENTIAL) ?? nonEmpty(file.credential) ?? nonEmpty(session?.credential),
    vaultKey: nonEmpty(flags.vaultKey) ?? nonEmpty(environment.UNKEEP_VAULT_KEY) ?? nonEmpty(file.vaultKey) ?? nonEmpty(file.vault_key),
  };
}

export function unkeepConfigDirectory(
  environment: Record<string, string | undefined>,
  override?: string,
): string {
  if (nonEmpty(override)) return override as string;
  const xdg = nonEmpty(environment.XDG_CONFIG_HOME);
  return join(xdg ?? join(homedir(), '.config'), 'unkeep');
}

export function decodeVaultKey(value: string): Uint8Array<ArrayBuffer> {
  const encoded = value.trim();
  let bytes: Buffer;
  if (/^[A-Fa-f0-9]{64}$/.test(encoded)) {
    bytes = Buffer.from(encoded, 'hex');
  } else {
    if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(encoded)) throw new Error('Vault key must be base64, base64url, or 64 hexadecimal characters');
    bytes = Buffer.from(encoded, 'base64url');
  }
  if (bytes.byteLength !== 32) throw new Error('Vault key must contain exactly 32 bytes');
  return new Uint8Array(bytes);
}

export function encodeVaultKey(value: Uint8Array): string {
  return Buffer.from(value).toString('base64url');
}
