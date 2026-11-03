// Debounce bursts, but retain changes arriving during an active run.
export function createScheduler(
  run: () => Promise<void>,
  delay = 300,
  onError: (error: unknown) => void = () => {},
): {
  schedule(): void;
  idle(): Promise<void>;
  close(): Promise<void>;
} {
  let dirty = false,
    closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void> | undefined;
  const drain = (): Promise<void> => {
    if (active) return active;
    active = (async () => {
      while (dirty && !closed) {
        dirty = false;
        try {
          await run();
        } catch (error) {
          onError(error);
        }
      }
    })().finally(() => {
      active = undefined;
    });
    return active;
  };
  return {
    schedule() {
      if (closed) return;
      dirty = true;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        void drain();
      }, delay);
    },
    async idle() {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      await drain();
    },
    async close() {
      closed = true;
      dirty = false;
      if (timer) clearTimeout(timer);
      await active;
    },
  };
}
