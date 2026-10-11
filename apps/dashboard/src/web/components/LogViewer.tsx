import { useEffect, useState } from 'react';
import type { LogsResponse } from '../../contracts.js';
import { usePolling } from '../usePolling.js';
import { Badge, ReadState } from './common.js';
export function LogViewer({ workspace, agents }: { workspace: string; agents: string[] }) {
  const [agent, setAgent] = useState('');
  const [level, setLevel] = useState('');
  const [auto, setAuto] = useState(true);
  const [cursor, setCursor] = useState<string | null>(null);
  const [direction, setDirection] = useState('backward');
  const [entries, setEntries] = useState<LogsResponse['entries']>([]);
  const params = new URLSearchParams({ direction, limit: '200' });
  if (agent) params.set('agent', agent);
  if (level) params.set('level', level);
  if (cursor) params.set('cursor', cursor);
  const read = usePolling<LogsResponse>(`/api/scans/${encodeURIComponent(workspace)}/logs?${params}`, auto ? 3000 : 0);
  useEffect(() => {
    if (read.errorCode === 'CursorInvalidated' || read.errorCode === 'ExecutionChanged') {
      setEntries([]);
      setCursor(null);
      setDirection('backward');
    }
  }, [read.errorCode]);
  useEffect(() => {
    const data = read.response?.data;
    if (!data) return;
    setEntries((old) => {
      const all = direction === 'backward' ? [...data.entries, ...old] : [...old, ...data.entries];
      return [...new Map(all.map((entry) => [entry.id, entry])).values()].slice(-1000);
    });
  }, [read.response, direction]);
  // Incremental live polling advances from a signed server cursor.
  useEffect(() => {
    const data = read.response?.data;
    if (auto && data && data.nextCursor !== cursor) {
      setDirection('forward');
      setCursor(data.nextCursor);
    }
  }, [read.response, auto, cursor]);
  const reset = () => {
    setEntries([]);
    setCursor(null);
    setDirection('backward');
  };
  return (
    <section>
      <div className="section-head">
        <h2>Execution logs</h2>
        <label className="checkbox">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          Auto-refresh (3s)
        </label>
      </div>
      <div className="filters">
        <label>
          Agent
          <select
            value={agent}
            onChange={(e) => {
              setAgent(e.target.value);
              reset();
            }}
          >
            <option value="">Combined workflow log</option>
            {agents.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
        <label>
          Level
          <select
            value={level}
            onChange={(e) => {
              setLevel(e.target.value);
              reset();
            }}
          >
            <option value="">All</option>
            {['info', 'warn', 'error'].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => {
            reset();
            read.refresh();
          }}
        >
          Reload latest
        </button>
        <button
          type="button"
          disabled={!read.response?.data?.olderCursor}
          onClick={() => {
            setAuto(false);
            setDirection('backward');
            setCursor(read.response?.data?.olderCursor ?? null);
          }}
        >
          Older entries
        </button>
      </div>
      <p className="muted">
        Workspace log history · raw lines, tool arguments, prompts and unknown text are withheld. Showing at most 1,000
        sanitized events.
      </p>
      <ReadState loading={!read.response && !read.error} error={read.error} stale={read.stale} />
      <div className="log-list">
        {entries.length ? (
          entries.map((entry) => (
            <div key={entry.id}>
              <time>{entry.timestamp ?? 'Unknown time'}</time>
              <Badge value={entry.level} />
              <strong>{entry.agent ?? entry.phase ?? 'scan'}</strong>
              <span>{entry.message}</span>
            </div>
          ))
        ) : (
          <p className="muted">No sanitized events available.</p>
        )}
      </div>
      {read.response?.data ? (
        <small className="muted">
          {read.response.data.omittedCount} unrecognized, filtered or sensitive lines omitted in the last read.
        </small>
      ) : null}
    </section>
  );
}
