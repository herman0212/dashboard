import { useEffect, useState } from 'react';
import type { FindingsResponse } from '../../contracts.js';
import { usePolling } from '../usePolling.js';
import { Badge, ReadState, Reference } from './common.js';
export function FindingsTable({ workspace, revision }: { workspace: string; revision: string }) {
  const [source, setSource] = useState('');
  const [severity, setSeverity] = useState('');
  const [confidence, setConfidence] = useState('');
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);
  useEffect(() => {
    if (revision) setCursor(null);
  }, [revision]);
  const params = new URLSearchParams();
  if (source) params.set('source', source);
  if (severity) params.set('severity', severity);
  if (confidence) params.set('confidence', confidence);
  if (search) params.set('q', search);
  if (cursor) params.set('cursor', cursor);
  const read = usePolling<FindingsResponse>(
    `/api/scans/${encodeURIComponent(workspace)}/findings?${params}`,
    0,
    revision,
  );
  const findings = read.response?.data;
  return (
    <section>
      <div className="section-head">
        <h2>Findings</h2>
        <button
          type="button"
          onClick={() => {
            setCursor(null);
            read.refresh();
          }}
        >
          Refresh
        </button>
      </div>
      <form
        className="filters"
        onSubmit={(e) => {
          e.preventDefault();
          setSearch(query);
          setCursor(null);
        }}
      >
        <label>
          Source
          <select
            value={source}
            onChange={(e) => {
              setSource(e.target.value);
              setCursor(null);
            }}
          >
            <option value="">Published default</option>
            <option value="final_report">Report</option>
            <option value="analysis_queue">Analysis queue</option>
            <option value="reconciliation">Reconciliation</option>
            <option value="exploitation_result">Exploitation results</option>
            <option value="capella">Capella</option>
          </select>
        </label>
        <label>
          Severity
          <select
            value={severity}
            onChange={(e) => {
              setSeverity(e.target.value);
              setCursor(null);
            }}
          >
            {['', 'critical', 'high', 'medium', 'low', 'unknown'].map((v) => (
              <option value={v} key={v}>
                {v || 'All'}
              </option>
            ))}
          </select>
        </label>
        <label>
          Confidence
          <select
            value={confidence}
            onChange={(e) => {
              setConfidence(e.target.value);
              setCursor(null);
            }}
          >
            {['', 'high', 'medium', 'low', 'unknown'].map((v) => (
              <option value={v} key={v}>
                {v || 'All'}
              </option>
            ))}
          </select>
        </label>
        <label>
          Search
          <input value={query} onChange={(e) => setQuery(e.target.value)} maxLength={200} />
        </label>
        <button type="submit">Apply</button>
      </form>
      <ReadState loading={!read.response && !read.error} error={read.error} stale={read.stale} />
      {findings ? (
        <>
          <p className="muted">
            Selected source: {findings.selectedSources.join(', ')} · {findings.page.total ?? 'Unknown'} records. Counts
            from different sources represent different stages.
          </p>
          <div className="source-counts">
            {findings.coverage.map((v) => (
              <span key={v.source}>
                {v.source}: {v.count ?? 'Unknown'} <Badge value={v.health} />
              </span>
            ))}
          </div>
          {findings.page.items.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Finding</th>
                    <th>Source / stage</th>
                    <th>Severity</th>
                    <th>Confidence</th>
                    <th>Confirmation / outcome</th>
                    <th>Evidence</th>
                  </tr>
                </thead>
                <tbody>
                  {findings.page.items.map((f) => (
                    <tr key={f.dashboardId}>
                      <td>
                        <strong>{f.findingId ?? 'Unknown ID'}</strong>
                        <p>{f.title ?? 'Title unavailable'}</p>
                        {f.locations.map((l) => (
                          <small key={JSON.stringify(l)}>
                            {l.display}
                            {l.startLine ? `:${l.startLine}` : ''}
                          </small>
                        ))}
                      </td>
                      <td>
                        {f.source}
                        <small>
                          {f.stage}
                          {f.sourceStage ? ` / ${f.sourceStage}` : ''}
                        </small>
                      </td>
                      <td>
                        <Badge value={f.severity} />
                      </td>
                      <td>
                        <Badge value={f.confidence} />
                      </td>
                      <td>
                        <Badge value={f.confirmation} />
                        <small>{f.outcome?.value ?? 'Unknown'}</small>
                      </td>
                      <td>
                        <details>
                          <summary>View evidence</summary>
                          {f.evidence.map((e) => (
                            <div key={e.label}>
                              <strong>{e.label}</strong>
                              <p className="text-block">{e.content}</p>
                            </div>
                          ))}
                        </details>
                        <Reference refs={f.provenance} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted">
              {findings.page.complete
                ? 'This source contains no matching findings.'
                : 'Findings are unavailable or not yet published.'}
            </p>
          )}
          <div className="pagination">
            <button type="button" disabled={!cursor} onClick={() => setCursor(null)}>
              First page
            </button>
            <button
              type="button"
              disabled={!findings.page.nextCursor}
              onClick={() => setCursor(findings.page.nextCursor)}
            >
              Next page
            </button>
          </div>
        </>
      ) : null}
    </section>
  );
}
