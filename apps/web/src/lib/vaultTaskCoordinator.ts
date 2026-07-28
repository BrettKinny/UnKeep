import { SingleFlight } from './singleFlight';

export interface VaultTaskContext {
  isCurrent(): boolean;
}

/** Load from captured vault resources, then synchronously hand the value to its
 * consumer only if that vault generation is still active. */
export async function useForCurrentVault<T, R>(
  context: VaultTaskContext,
  load: () => Promise<T>,
  use: (value: T) => R | Promise<R>,
): Promise<R | undefined> {
  const value = await load();
  if (!context.isCurrent()) return undefined;
  return use(value);
}

export class VaultTaskCoordinator {
  private generation = 0;
  private flight = new SingleFlight();

  reset(): void {
    this.generation++;
    this.flight = new SingleFlight();
  }

  capture(): VaultTaskContext {
    const generation = this.generation;
    return { isCurrent: () => generation === this.generation };
  }

  run(task: (context: VaultTaskContext) => Promise<void>): Promise<void> {
    const context = this.capture();
    return this.flight.run(() => task(context));
  }
}
