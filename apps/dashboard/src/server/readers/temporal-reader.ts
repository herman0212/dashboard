import { type DashboardExecution, readDashboardExecution } from '@keygraph/astra/dashboard-read';
export interface TemporalRead {
  execution: DashboardExecution | null;
  health: 'fresh' | 'stale' | 'unavailable';
  observedAt: string | null;
  reasonCode: string | null;
}
const previous = new Map<string, { execution: DashboardExecution; observedAt: string }>();
const inFlight = new Map<string, Promise<TemporalRead>>();
const cache = new Map<string, { value: TemporalRead; expires: number }>();
let outageUntil = 0;
export function clearTemporalCache(): void {
  previous.clear();
  cache.clear();
  outageUntil = 0;
}
/** Cache contains prior observations, never a reconstructed execution state. */
export async function readTemporal(workflowId: string): Promise<TemporalRead> {
  if (outageUntil > Date.now()) {
    const old = previous.get(workflowId);
    return {
      execution: old?.execution ?? null,
      health: old ? 'stale' : 'unavailable',
      observedAt: old?.observedAt ?? null,
      reasonCode: 'TemporalUnavailable',
    };
  }
  const cached = cache.get(workflowId);
  if (cached && cached.expires > Date.now()) return cached.value;
  const existing = inFlight.get(workflowId);
  if (existing) return existing;
  const work = (async (): Promise<TemporalRead> => {
    try {
      const execution = await readDashboardExecution(workflowId);
      const observedAt = new Date().toISOString();
      if (execution) previous.set(workflowId, { execution, observedAt });
      else previous.delete(workflowId);
      const result: TemporalRead = {
        execution,
        health: execution ? 'fresh' : 'unavailable',
        observedAt,
        reasonCode: execution ? null : 'ExecutionNotFound',
      };
      cache.set(workflowId, { value: result, expires: Date.now() + 1500 });
      return result;
    } catch {
      outageUntil = Date.now() + 10000;
      const old = previous.get(workflowId);
      return {
        execution: old?.execution ?? null,
        health: old ? 'stale' : 'unavailable',
        observedAt: old?.observedAt ?? null,
        reasonCode: 'TemporalUnavailable',
      };
    } finally {
      inFlight.delete(workflowId);
    }
  })();
  inFlight.set(workflowId, work);
  // Bound the lifetime and size of observation caches.
  if (previous.size > 200) {
    const first = previous.keys().next().value;
    if (first) {
      previous.delete(first);
      cache.delete(first);
    }
  }
  return work;
}
