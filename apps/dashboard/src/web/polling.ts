export interface PollOptions<T> {
  task: (signal: AbortSignal) => Promise<T>;
  interval: number | ((data: T | null) => number);
  data: (value: T) => void;
  error: (error: unknown) => void;
  visible?: () => boolean;
  schedule?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
  random?: () => number;
}
export function poll<T>(options: PollOptions<T>) {
  let stopped = false;
  let controller: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  let failures = 0;
  let latest: T | null = null;
  const schedule: NonNullable<PollOptions<T>['schedule']> =
    options.schedule ?? ((callback, ms) => setTimeout(callback, ms));
  const cancel = options.cancel ?? clearTimeout;
  const delay = () => (typeof options.interval === 'function' ? options.interval(latest) : options.interval);
  const tick = async () => {
    timer = null;
    if (stopped || inFlight) return;
    if (options.visible && !options.visible()) {
      timer = schedule(() => {
        void tick();
      }, 1000);
      return;
    }
    inFlight = true;
    controller = new AbortController();
    const current = controller;
    const timeout = setTimeout(() => current.abort(), 15000);
    try {
      const value = await options.task(current.signal);
      if (!stopped && !current.signal.aborted) {
        latest = value;
        failures = 0;
        options.data(value);
      } else if (!stopped) {
        failures++;
        options.error(new Error('Request timed out.'));
      }
    } catch (error) {
      if (!stopped) {
        failures++;
        options.error(error);
      }
    } finally {
      clearTimeout(timeout);
      inFlight = false;
      controller = null;
      if (!stopped) {
        const ms = failures
          ? failures <= 3
            ? Math.min(10000, 1000 * 2 ** (failures - 1)) + Math.floor((options.random ?? Math.random)() * 300)
            : 30000
          : delay();
        if (ms > 0)
          timer = schedule(() => {
            void tick();
          }, ms);
      }
    }
  };
  void tick();
  return {
    refresh: () => {
      if (stopped || inFlight) return;
      if (timer) cancel(timer);
      timer = null;
      void tick();
    },
    stop: () => {
      stopped = true;
      controller?.abort();
      if (timer) cancel(timer);
      timer = null;
    },
  };
}
