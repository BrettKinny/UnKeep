interface PendingWork<T> {
  token: number;
  value: T;
  run(value: T): Promise<void>;
}

/**
 * Owns debounced work until it has either started or been durably drained.
 * `drain` keeps looping because callers may enqueue newer work while an older
 * operation is awaiting storage.
 */
export class DebouncedWorkQueue<T> {
  private readonly pending = new Map<string, PendingWork<T>>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly active = new Set<Promise<void>>();
  private readonly tokens = new Map<string, number>();

  constructor(private readonly delayMs: number) {}

  schedule(key: string, value: T, run: (value: T) => Promise<void>): void {
    this.clearPending(key);
    const token = (this.tokens.get(key) ?? 0) + 1;
    this.tokens.set(key, token);
    this.pending.set(key, { token, value, run });
    const timer = setTimeout(() => {
      if (this.timers.get(key) !== timer) return;
      this.timers.delete(key);
      const work = this.pending.get(key);
      if (!work) return;
      this.pending.delete(key);
      const operation = Promise.resolve()
        .then(() => work.run(work.value))
        .catch(error => {
          if (this.tokens.get(key) === work.token && !this.pending.has(key)) {
            this.pending.set(key, work);
          }
          throw error;
        });
      this.active.add(operation);
      void operation.then(
        () => this.active.delete(operation),
        () => this.active.delete(operation),
      );
    }, this.delayMs);
    this.timers.set(key, timer);
  }

  cancel(key: string): void {
    this.clearPending(key);
    this.tokens.set(key, (this.tokens.get(key) ?? 0) + 1);
  }

  private clearPending(key: string): void {
    const timer = this.timers.get(key);
    if (timer) clearTimeout(timer);
    this.timers.delete(key);
    this.pending.delete(key);
  }

  async drain(run: (value: T) => Promise<void>): Promise<void> {
    while (this.pending.size || this.active.size) {
      if (this.active.size) {
        await Promise.all([...this.active]);
        continue;
      }
      const pending = [...this.pending.entries()];
      for (const [key, work] of pending) {
        if (this.pending.get(key) !== work) continue;
        const timer = this.timers.get(key);
        if (timer) clearTimeout(timer);
        this.timers.delete(key);
        this.pending.delete(key);
        try {
          await run(work.value);
        } catch (error) {
          if (this.tokens.get(key) === work.token && !this.pending.has(key)) {
            this.pending.set(key, work);
          }
          throw error;
        }
      }
    }
  }
}
