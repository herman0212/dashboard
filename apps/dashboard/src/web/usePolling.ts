import { useEffect, useRef, useState } from 'react';
import type { ApiResponse } from '../contracts.js';
import { ApiError, get } from './api.js';
import { poll } from './polling.js';
export function usePolling<T>(
  url: string,
  interval: number | ((value: ApiResponse<T> | null) => number),
  revision = '',
) {
  const key = `${url}|${revision}`;
  const [state, setState] = useState<{
    key: string;
    value: ApiResponse<T> | null;
    error: string | null;
    errorCode: string | null;
    stale: boolean;
  }>({ key, value: null, error: null, errorCode: null, stale: false });
  const delay = useRef(interval);
  delay.current = interval;
  const runner = useRef<ReturnType<typeof poll<ApiResponse<T>>> | null>(null);
  useEffect(() => {
    setState({ key, value: null, error: null, errorCode: null, stale: false });
    const current = poll<ApiResponse<T>>({
      task: (signal) => get<T>(url, signal),
      interval: (value) => (typeof delay.current === 'function' ? delay.current(value) : delay.current),
      visible: () => document.visibilityState === 'visible',
      data: (value) => setState({ key, value, error: null, errorCode: null, stale: value.meta.health === 'stale' }),
      error: (error) =>
        setState((previous) => ({
          ...previous,
          error: error instanceof Error ? error.message : 'Data unavailable.',
          errorCode: error instanceof ApiError ? error.code : null,
          stale: previous.value !== null,
        })),
    });
    runner.current = current;
    const refresh = () => {
      if (document.visibilityState === 'visible') current.refresh();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      current.stop();
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [key, url]);
  return {
    response: state.key === key ? state.value : null,
    error: state.key === key ? state.error : null,
    errorCode: state.key === key ? state.errorCode : null,
    stale: state.key === key && state.stale,
    refresh: () => runner.current?.refresh(),
  };
}
