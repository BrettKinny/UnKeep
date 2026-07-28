import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadRecoveryKit } from './recoveryKit';

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
