import assert from 'node:assert/strict';
import { test } from 'node:test';
import { poll } from '../src/web/polling.js';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
test('polling never overlaps and suppresses responses from a disposed workspace', async () => {
  let release: ((v: string) => void) | null = null;
  let calls = 0;
  const values: string[] = [];
  let signal: AbortSignal | null = null;
  const runner = poll({
    task: (s) => {
      calls++;
      signal = s;
      return new Promise<string>((resolve) => {
        release = resolve;
      });
    },
    interval: 3000,
    data: (v) => values.push(v),
    error: () => {},
  });
  runner.refresh();
  assert.equal(calls, 1);
  runner.stop();
  assert.equal((signal as AbortSignal | null)?.aborted, true);
  (release as ((v: string) => void) | null)?.('old workspace');
  await flush();
  assert.deepEqual(values, []);
});
test('polling schedules only after completion and retries in bounded bursts', async () => {
  const scheduled: { callback: () => void; delay: number }[] = [];
  const delays: number[] = [];
  const runner = poll({
    task: async () => {
      throw new Error('unavailable');
    },
    interval: 3000,
    data: () => {},
    error: () => {},
    random: () => 0,
    schedule: (callback, delay) => {
      scheduled.push({ callback, delay });
      delays.push(delay);
      return setTimeout(() => {}, 0);
    },
    cancel: clearTimeout,
  });
  for (let i = 0; i < 4; i++) {
    await flush();
    scheduled.shift()?.callback();
  }
  await flush();
  runner.stop();
  assert.deepEqual(delays.slice(0, 5), [1000, 2000, 4000, 30000, 30000]);
});
test('hidden pages do not issue requests until visible', async () => {
  let visible = false;
  let calls = 0;
  const scheduled: (() => void)[] = [];
  const runner = poll({
    task: async () => {
      calls++;
      return 1;
    },
    interval: 10000,
    visible: () => visible,
    data: () => {},
    error: () => {},
    schedule: (callback) => {
      scheduled.push(callback);
      return setTimeout(() => {}, 0);
    },
    cancel: clearTimeout,
  });
  assert.equal(calls, 0);
  visible = true;
  scheduled.shift()?.();
  await flush();
  assert.equal(calls, 1);
  runner.stop();
});
