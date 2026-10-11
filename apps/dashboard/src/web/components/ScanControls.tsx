import { useEffect, useState } from 'react';
import type { ControlCapabilities, ControlOperation } from '../../contracts.js';
import { controlPost } from '../api.js';
import { startScanReady } from '../start-readiness.js';
import { usePolling } from '../usePolling.js';
import { Badge, ReadState } from './common.js';

export function NewScan({ back, started }: { back: () => void; started: (operation: ControlOperation) => void }) {
  const capabilities = usePolling<ControlCapabilities>('/api/control/capabilities', 5000);
  const [url, setUrl] = useState('');
  const [repository, setRepository] = useState('');
  const [authorized, setAuthorized] = useState(false);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const config = capabilities.response?.data;
  const ready = startScanReady(config, url, repository, authorized, busy, capabilities.stale);
  useEffect(() => {
    const firstRoot = config?.repositoryRoots[0];
    if (firstRoot) setRepository((current) => (config.repositoryRoots.includes(current) ? current : firstRoot));
  }, [config?.repositoryRoots]);
  const changed = () => {
    setRequestId(crypto.randomUUID());
    setError(null);
  };
  return (
    <>
      <div className="page-head">
        <div>
          <button type="button" className="back" onClick={back}>
            ← All scans
          </button>
          <h1>New scan</h1>
          <p>Launch Astra against a target you are authorized to test.</p>
        </div>
      </div>
      <ReadState
        loading={!capabilities.response && !capabilities.error}
        error={capabilities.error}
        stale={capabilities.stale}
      />
      <section>
        <div className="section-head">
          <h2>Runner readiness</h2>
          <button type="button" onClick={capabilities.refresh}>
            Check again
          </button>
        </div>
        {config?.runtime ? <p className="muted">Execution environment: {config.runtime}</p> : null}
        {config?.issues && config.issues.length > 1 ? (
          <ul>
            {config.issues.map((issue) => (
              <li key={issue.code}>{issue.message}</li>
            ))}
          </ul>
        ) : null}
        {config?.reason ? (
          <p className="control-warning" role="status">
            {config.reason}
          </p>
        ) : null}
        <form
          className="scan-form"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!ready) return;
            setBusy(true);
            setError(null);
            try {
              const operation = await controlPost<ControlOperation>('/api/scans', {
                requestId,
                url,
                repository,
                authorized,
              });
              started(operation);
            } catch (failure) {
              setError(failure instanceof Error ? failure.message : 'Scan launch request failed.');
            } finally {
              setBusy(false);
            }
          }}
        >
          <label htmlFor="target-url">Target URL</label>
          <input
            id="target-url"
            type="url"
            required
            maxLength={2048}
            placeholder="https://your-authorized-target.example"
            value={url}
            disabled={busy}
            onChange={(event) => {
              setUrl(event.target.value);
              changed();
            }}
          />
          <label htmlFor="source-directory">Source repository / directory</label>
          <select
            id="source-directory"
            required
            value={repository}
            disabled={busy}
            onChange={(event) => {
              setRepository(event.target.value);
              changed();
            }}
          >
            {!config?.repositoryRoots.length ? <option value="">No source directories available</option> : null}
            {config?.repositoryRoots.map((root) => (
              <option key={root} value={root}>
                {root}
              </option>
            ))}
          </select>
          <p className="muted">Choose a source directory configured by the runner operator:</p>
          <ul className="allowed-roots">
            {config?.repositoryRoots.map((root) => (
              <li key={root}>
                <code>{root}</code>
              </li>
            ))}
          </ul>
          <label className="authorization" htmlFor="target-authorization">
            <input
              id="target-authorization"
              type="checkbox"
              required
              checked={authorized}
              disabled={busy}
              onChange={(event) => {
                setAuthorized(event.target.checked);
                changed();
              }}
            />
            I own this target or have explicit permission to perform penetration testing on it.
          </label>
          <p className="muted">
            Readiness checks Docker and configured credentials. Astra still checks model access and target reachability
            during preflight. Private targets need an explicit runner host allowlist. Workspace:{' '}
            {config?.workspaceRoot ?? 'Loading…'}
          </p>
          {error ? (
            <p role="alert" className="control-warning">
              {error}
            </p>
          ) : null}
          <button type="submit" disabled={!ready}>
            {busy ? 'Submitting…' : 'Start scan'}
          </button>
        </form>
      </section>
    </>
  );
}
export function LaunchHistory({ open }: { open: (workspace: string, operationId?: string) => void }) {
  const read = usePolling<ControlOperation[]>('/api/control/operations', 3000);
  const items = read.response?.data ?? [];
  if (!items.length && !read.error) return null;
  return (
    <section>
      <h2>Launch and stop requests</h2>
      <ReadState loading={!read.response && !read.error} error={read.error} stale={read.stale} />
      <p className="muted">
        CLI process status is separate from scan execution. A launcher exiting does not prove scan completion.
      </p>
      <ul className="control-history">
        {items.slice(0, 12).map((operation) => (
          <li key={operation.id}>
            <button type="button" className="workspace-link" onClick={() => open(operation.workspace, operation.id)}>
              {operation.workspace}
            </button>
            <span>{operation.kind}</span>
            <Badge value={operation.processState} />
            {operation.error ? <span role="status">{operation.error.message}</span> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
export function ScanControlPanel({
  workspace,
  operationId,
  canStop,
}: {
  workspace: string;
  operationId: string | null;
  canStop: boolean;
}) {
  const config = usePolling<ControlCapabilities>('/api/control/capabilities', 30000);
  const read = usePolling<ControlOperation[]>('/api/control/operations', 3000);
  const items = read.response?.data?.filter((operation) => operation.workspace === workspace) ?? [];
  const operation = items.find((item) => item.id === operationId) ?? items[0];
  const [busy, setBusy] = useState(false);
  const [stopId, setStopId] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<string | null>(null);
  return (
    <section>
      <div className="section-head">
        <h2>Scan controls</h2>
        <button
          type="button"
          disabled={
            busy ||
            !canStop ||
            !(config.response?.data?.stopAvailable ?? config.response?.data?.available) ||
            config.stale
          }
          onClick={async () => {
            if (!window.confirm('Stop this scan? Astra will request workflow cancellation and stop its worker.'))
              return;
            setBusy(true);
            setError(null);
            try {
              await controlPost<ControlOperation>(`/api/scans/${encodeURIComponent(workspace)}/stop`, {
                requestId: stopId,
                confirmed: true,
              });
              setStopId(crypto.randomUUID());
              read.refresh();
            } catch (failure) {
              setError(failure instanceof Error ? failure.message : 'Stop request failed.');
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Submitting stop…' : 'Stop scan'}
        </button>
      </div>
      {config.response?.data?.reason ? <p className="muted">{config.response.data.reason}</p> : null}
      <ReadState
        loading={!read.response && !read.error}
        error={read.error ?? config.error}
        stale={read.stale || config.stale}
      />
      {operation ? (
        <>
          <p>
            {operation.kind === 'start' ? 'Start launcher' : 'Stop launcher'}: <Badge value={operation.processState} />
            {operation.exitCode !== null ? ` · exit code ${operation.exitCode}` : ''}
          </p>
          <p className="muted">
            Request {operation.id} · {operation.updatedAt}
          </p>
          {operation.error ? (
            <p role="alert" className="control-warning">
              {operation.error.message}
            </p>
          ) : null}
          <p className="muted">
            Scan status below comes from workspace and Temporal evidence. Stop is verified there, not by this request.
          </p>
        </>
      ) : (
        <p className="muted">No Dashboard control request recorded for this workspace.</p>
      )}
      {error ? (
        <p role="alert" className="control-warning">
          {error}
        </p>
      ) : null}
    </section>
  );
}
