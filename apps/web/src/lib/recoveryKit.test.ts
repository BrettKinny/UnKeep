import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  downloadRecoveryKit,
  MAX_RECOVERY_KIT_FILE_SIZE,
  readRecoveryKitFile,
} from './recoveryKit';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('recovery kit download', () => {
  it('keeps the object URL alive through the browser download gesture', () => {
    vi.useFakeTimers();
    const click = vi.fn();
    const remove = vi.fn();
    const append = vi.fn();
    const anchor = { href: '', download: '', click, remove };
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('document', {
      createElement: vi.fn(() => anchor),
      body: { append },
    });
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:recovery-kit'),
      revokeObjectURL,
    });

    downloadRecoveryKit('{"version":2,"instanceId":"vault-one"}');

    expect(append).toHaveBeenCalledWith(anchor);
    expect(click).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:recovery-kit');
  });
});

describe('recovery kit input', () => {
  it('rejects an oversized kit before reading its text', async () => {
    const file = new File(['{}'], 'recovery.json', { type: 'application/json' });
    const text = vi.fn(async () => { throw new Error('must not read'); });
    Object.defineProperty(file, 'size', { value: MAX_RECOVERY_KIT_FILE_SIZE + 1 });
    Object.defineProperty(file, 'text', { value: text });

    await expect(readRecoveryKitFile(file)).rejects.toThrow('64 KiB or smaller');
    expect(text).not.toHaveBeenCalled();
  });
});
