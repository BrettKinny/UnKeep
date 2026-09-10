interface PendingWork<T> {
  token: number;
  value: T;
  run(value: T, options?: { deferRemote?: boolean }): Promise<void>;
}

/**
 * Owns debounced work until it has either started or been durably drained.
 * `drain` keeps looping because callers may enqueue newer work while an older
 * operation is awaiting storage.
 */
export class DebouncedWorkQueue<T> {
  private readonly pending = new Map<string, PendingWork<T>>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly active = new Map<string, Set<Promise<void>>>();
  private readonly tokens = new Map<string, number>();

  constructor(private readonly delayMs: number) {}

  schedule(
    key: string,
    value: T,
    run: (value: T, options?: { deferRemote?: boolean }) => Promise<void>,
  ): void {
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
      this.trackActive(key, operation);
    }, this.delayMs);
    this.timers.set(key, timer);
  }

  /**
   * Invalidate queued work and wait for an older operation for this key. The
   * caller can then perform an immediate write without allowing an older
   * snapshot to finish after it.
   */
  async supersede(key: string): Promise<void> {
    this.cancel(key);
    try {
      await Promise.all([...(this.active.get(key) ?? [])]);
    } catch {
      // A failed stale operation is already retained by its caller's retry
      // path; the newer mutation must still be allowed to proceed.
    }
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

  private trackActive(key: string, operation: Promise<void>): void {
    const operations = this.active.get(key) ?? new Set<Promise<void>>();
    operations.add(operation);
    this.active.set(key, operations);
    void operation.then(
      () => this.untrackActive(key, operations, operation),
      () => this.untrackActive(key, operations, operation),
    );
  }

  private untrackActive(
    key: string,
    operations: Set<Promise<void>>,
    operation: Promise<void>,
  ): void {
    operations.delete(operation);
    if (!operations.size) this.active.delete(key);
  }

  async drain(
    runOrOptions:
      | ((value: T) => Promise<void>)
      | { deferRemote?: boolean } = {},
  ): Promise<void> {
    const run = typeof runOrOptions === 'function' ? runOrOptions : undefined;
    const deferRemote = typeof runOrOptions === 'function'
      ? false
      : (runOrOptions.deferRemote ?? false);
    while (this.pending.size || this.active.size) {
      if (this.active.size) {
        await Promise.all(
          [...this.active.values()].flatMap(operations => [...operations]),
        );
        continue;
      }
      const pending = [...this.pending.entries()];
      for (const [key, work] of pending) {
        if (this.pending.get(key) !== work) continue;
        const timer = this.timers.get(key);
        if (timer) clearTimeout(timer);
        this.timers.delete(key);
        this.pending.delete(key);
        const operation = Promise.resolve().then(() => (
          run ? run(work.value) : work.run(work.value, { deferRemote })
        ));
        this.trackActive(key, operation);
        try {
          await operation;
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
