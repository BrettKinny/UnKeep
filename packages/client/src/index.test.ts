import { describe, expect, it } from 'vitest';
import {
  PairingLocalStateChangedError,
  type PairingKeyInstallation,
  type PairingKeySnapshot,
  type PairingStorageIsolation,
} from './index.js';

function publicPairingTypes(
  snapshot: PairingKeySnapshot,
  installation: PairingKeyInstallation,
  isolation: PairingStorageIsolation,
): readonly unknown[] {
  return [snapshot, installation, isolation];
}

describe('@unkeep/client public pairing API', () => {
  it('exports the actionable local-state error and the types in public signatures', () => {
    const error = new PairingLocalStateChangedError();
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('PairingLocalStateChangedError');
    expect(publicPairingTypes).toBeTypeOf('function');
  });
});
