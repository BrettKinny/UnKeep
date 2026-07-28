/** Coalesce overlapping triggers into one run without suppressing later work. */
export class SingleFlight {
  private current: Promise<void> | null = null;

  run(task: () => Promise<void>): Promise<void> {
    if (this.current) return this.current;
    const operation = task();
    const tracked = operation.finally(() => {
      if (this.current === tracked) this.current = null;
    });
    this.current = tracked;
    return tracked;
  }
}
