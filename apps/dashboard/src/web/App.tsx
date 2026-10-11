import { useEffect, useState } from 'react';
import type { ApiResponse, ControlOperation, Page, ScanDetail, ScanSummary } from '../contracts.js';
import { AgentTable } from './components/AgentTable.js';
import { Badge, Duration, ReadState } from './components/common.js';
import { DeliverablesPanel } from './components/DeliverablesPanel.js';
import { FindingsTable } from './components/FindingsTable.js';
import { IssuesPanel } from './components/IssuesPanel.js';
import { LogViewer } from './components/LogViewer.js';
import { ReportPanel } from './components/ReportPanel.js';
import { LaunchHistory, NewScan, ScanControlPanel } from './components/ScanControls.js';
import { ScanOverview } from './components/ScanOverview.js';
import { SourceHealthBanner } from './components/SourceHealthBanner.js';
import { WorkflowTimeline } from './components/WorkflowTimeline.js';
import { usePolling } from './usePolling.js';

const detailInterval = (value: ApiResponse<ScanDetail> | null) =>
  ['COMPLETED', 'FAILED', 'CANCELLED', 'TERMINATED', 'TIMED_OUT', 'CONTINUED_AS_NEW'].includes(
    value?.data?.summary.executionStatus.value ?? '',
  )
    ? 30000
    : 3000;
function ScanListPage({ open, newScan }: { open: (name: string, operationId?: string) => void; newScan: () => void }) {
  const [cursor, setCursor] = useState<string | null>(null);
  const read = usePolling<Page<ScanSummary>>(
    `/api/scans${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
    10000,
  );
  const page = read.response?.data;
  return (
    <>
      <div className="page-head">
        <div>
          <p className="eyebrow">ASTRA · PENTEST CONTROL</p>
          <h1>Scan dashboard</h1>
          <p>Real execution evidence from Temporal and Astra workspaces.</p>
        </div>
        <div className="control-actions">
          <button type="button" onClick={newScan}>
            New scan
          </button>
          <button type="button" onClick={read.refresh}>
            Refresh scans
          </button>
        </div>
      </div>
      <ReadState loading={!read.response && !read.error} error={read.error} stale={read.stale} />
      {read.response ? (
        <div className="list-summary">
          <strong>{page?.total ?? 'Unknown'} workspaces</strong>
          <Badge value={read.response.meta.health} />
          <span>Refresh every 10 seconds</span>
        </div>
      ) : null}
      <section>
        <div className="table-wrap">
          <table className="scan-table">
            <thead>
              <tr>
                <th>Workspace / target</th>
                <th>Execution status</th>
                <th>Business status</th>
                <th>Current phase</th>
                <th>Elapsed</th>
                <th>Report</th>
              </tr>
            </thead>
            <tbody>
              {page?.items.map((scan) => (
                <tr key={scan.workspace}>
                  <td>
                    <button type="button" className="workspace-link" onClick={() => open(scan.workspace)}>
                      {scan.workspace}
                    </button>
                    <small>{scan.target.value ?? 'Target unknown'}</small>
                  </td>
                  <td>
                    <Badge value={scan.executionStatus.value} />
                    {scan.stale ? <Badge value="stale" /> : null}
                  </td>
                  <td>
                    <Badge value={scan.businessStatus.value} />
                  </td>
                  <td>{scan.currentPhase.value ?? 'Unknown'}</td>
                  <td>
                    <Duration ms={scan.elapsedMs.value} />
                  </td>
                  <td>
                    <Badge value={scan.reportLifecycle.value} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {page?.items.length === 0 ? (
          <div className="empty">
            <h2>No scan workspaces available</h2>
            <p>Astra scan results will appear here when they exist in the configured workspace root.</p>
            <p className="muted">Use New scan to launch Astra in a supported environment.</p>
          </div>
        ) : null}
        <div className="pagination">
          <button type="button" disabled={!cursor} onClick={() => setCursor(null)}>
            First page
          </button>
          <button type="button" disabled={!page?.nextCursor} onClick={() => setCursor(page?.nextCursor ?? null)}>
            Next page
          </button>
        </div>
      </section>
      <IssuesPanel issues={read.response?.meta.issues ?? []} />
      <LaunchHistory open={open} />
    </>
  );
}
function ScanDetailPage({
  workspace,
  back,
  operationId,
}: {
  workspace: string;
  back: () => void;
  operationId: string | null;
}) {
  const [tab, setTab] = useState('overview');
  const read = usePolling<ScanDetail>(`/api/scans/${encodeURIComponent(workspace)}`, detailInterval);
  const data = read.response?.data;
  const revision = read.response?.meta.snapshotId ?? '';
  return (
    <>
      <div className="page-head">
        <div>
          <button type="button" className="back" onClick={back}>
            ← All scans
          </button>
          <h1>{workspace}</h1>
          <p>Execution and business outcomes are shown separately.</p>
        </div>
        <button type="button" onClick={read.refresh}>
          Refresh scan
        </button>
      </div>
      <ReadState loading={!read.response && !read.error} error={read.error} stale={read.stale} />
      <ScanControlPanel
        workspace={workspace}
        operationId={operationId}
        canStop={
          Boolean(data) &&
          !['COMPLETED', 'FAILED', 'CANCELLED', 'TERMINATED', 'TIMED_OUT'].includes(
            data?.summary.executionStatus.value ?? '',
          )
        }
      />
      {!data && operationId ? (
        <p className="muted">
          The launch request is tracked above. Execution details appear when Astra creates the workspace; an HTTP
          request alone does not prove the scan started.
        </p>
      ) : null}
      {data ? (
        <>
          <SourceHealthBanner sources={data.summary.sourceHealth} stale={read.stale} />
          <ScanOverview scan={data.summary} />
          <nav className="tabs" aria-label="Scan sections">
            {['overview', 'findings', 'logs', 'deliverables', 'report'].map((name) => (
              <button
                type="button"
                key={name}
                className={name === tab ? 'selected' : ''}
                aria-current={name === tab ? 'page' : undefined}
                onClick={() => setTab(name)}
              >
                {name[0]?.toUpperCase()}
                {name.slice(1)}
              </button>
            ))}
          </nav>
          {tab === 'overview' ? (
            <>
              <WorkflowTimeline progress={data.workflow} />
              <AgentTable agents={data.agents.agents} />
              <IssuesPanel issues={data.summary.issues} />
            </>
          ) : null}
          {tab === 'findings' ? <FindingsTable workspace={workspace} revision={revision} /> : null}
          {tab === 'logs' ? <LogViewer workspace={workspace} agents={data.agents.agents.map((a) => a.name)} /> : null}
          {tab === 'deliverables' ? <DeliverablesPanel workspace={workspace} revision={revision} /> : null}
          {tab === 'report' ? <ReportPanel workspace={workspace} revision={revision} /> : null}
        </>
      ) : null}
    </>
  );
}
function selected() {
  try {
    return window.location.hash ? decodeURIComponent(window.location.hash.slice(1).split('?')[0] ?? '') : null;
  } catch {
    return null;
  }
}
export function App() {
  const [workspace, setWorkspace] = useState<string | null>(selected);
  const [operationId, setOperationId] = useState(() =>
    new URLSearchParams(window.location.hash.split('?')[1]).get('operation'),
  );
  useEffect(() => {
    const change = () => {
      setWorkspace(selected());
      setOperationId(new URLSearchParams(window.location.hash.split('?')[1]).get('operation'));
    };
    window.addEventListener('hashchange', change);
    return () => window.removeEventListener('hashchange', change);
  }, []);
  return (
    <div className="app">
      <header className="topbar">
        <a href="/" className="brand">
          <span className="brand-mark">A</span>
          <span>
            ASTRA<small>AI Agent Dashboard</small>
          </span>
        </a>
        <span className="read-only">
          <span />
          Pentest control · localhost
        </span>
      </header>
      <main>
        {workspace === '/new' ? (
          <NewScan
            back={() => {
              window.location.hash = '';
            }}
            started={(operation: ControlOperation) => {
              window.location.hash = `${encodeURIComponent(operation.workspace)}?operation=${operation.id}`;
            }}
          />
        ) : workspace ? (
          <ScanDetailPage
            key={workspace}
            workspace={workspace}
            operationId={operationId}
            back={() => {
              window.location.hash = '';
              setWorkspace(null);
            }}
          />
        ) : (
          <ScanListPage
            newScan={() => {
              window.location.hash = '/new';
            }}
            open={(name, id) => {
              window.location.hash = `${encodeURIComponent(name)}${id ? `?operation=${id}` : ''}`;
              setWorkspace(name);
              setOperationId(id ?? null);
            }}
          />
        )}
      </main>
      <footer>Astra CLI controls · Temporal execution evidence · Workspace artifacts</footer>
    </div>
  );
}
