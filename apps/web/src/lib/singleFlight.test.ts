import { describe, expect, it } from 'vitest';
import { SingleFlight } from './singleFlight';

describe('SingleFlight', () => {
  it('shares one in-flight run across concurrent callers and allows a later run', async () => {
    const flight = new SingleFlight();
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let runs = 0;
    const task = async () => { runs++; await blocked; };

    const first = flight.run(task);
    const second = flight.run(task);
    expect(first).toBe(second);
    expect(runs).toBe(1);

    release();
    await first;
    await flight.run(async () => { runs++; });
    expect(runs).toBe(2);
  });

  it('can run again after a failed task', async () => {
    const flight = new SingleFlight();
    await expect(flight.run(async () => { throw new Error('offline'); })).rejects.toThrow('offline');
    await expect(flight.run(async () => undefined)).resolves.toBeUndefined();
  });
});
