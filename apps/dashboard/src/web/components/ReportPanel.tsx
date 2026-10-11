import type { ReportResponse } from '../../contracts.js';
import { usePolling } from '../usePolling.js';
import { Badge, ReadState, Value } from './common.js';
import { ArtifactLink } from './DeliverablesPanel.js';
export function ReportPanel({ workspace, revision }: { workspace: string; revision: string }) {
  const read = usePolling<ReportResponse>(`/api/scans/${encodeURIComponent(workspace)}/report`, 0, revision);
  const report = read.response?.data;
  return (
    <section>
      <div className="section-head">
        <h2>Final report</h2>
        <button type="button" onClick={read.refresh}>
          Refresh
        </button>
      </div>
      <ReadState loading={!read.response && !read.error} error={read.error} stale={read.stale} />
      {report ? (
        <>
          <div className="report-status">
            <span>
              Recorded lifecycle <Badge value={report.lifecycle.value} />
            </span>
            <span>
              Integrity <Badge value={report.integrity} />
            </span>
            <span>
              Mode <Badge value={report.mode.value} />
            </span>
          </div>
          {report.lifecycle.value !== 'finalized' ? (
            <p className="notice">
              Final report is not established. A report.json file alone does not prove finalization.
            </p>
          ) : report.integrity !== 'verified' ? (
            <p className="notice error">The recorded finalization could not be verified. Publication is blocked.</p>
          ) : (
            <p className="notice success">Final report verified against Astra checkpoints and finalization manifest.</p>
          )}
          <dl>
            <dt>Target</dt>
            <dd>
              <Value fact={report.target} />
            </dd>
            <dt>Assessment date</dt>
            <dd>
              <Value fact={report.assessmentDate} />
            </dd>
            <dt>Coverage</dt>
            <dd>
              <Badge value={report.coverage.value?.status} />
            </dd>
            <dt>Model checkpoint</dt>
            <dd>
              <Value fact={report.modelCheckpoint} />
            </dd>
            <dt>Canonical checkpoint</dt>
            <dd>
              <Value fact={report.canonicalCheckpoint} />
            </dd>
            <dt>Final checkpoint</dt>
            <dd>
              <Value fact={report.finalCheckpoint} />
            </dd>
          </dl>
          <h3>Executive summary</h3>
          <p className="text-block">{report.executiveSummary.value ?? 'Unavailable'}</p>
          <div className="outputs">
            {Object.entries(report.outputs).map(([format, artifact]) => (
              <div key={format}>
                <strong>{format.toUpperCase()}</strong>
                <Badge value={artifact?.status} />
                {artifact ? <ArtifactLink artifact={artifact} /> : <span>Unavailable</span>}
              </div>
            ))}
          </div>
          {report.coverage.value?.limitations.map((v) => (
            <p key={v.code} className="notice">
              {v.message}
            </p>
          ))}
        </>
      ) : null}
    </section>
  );
}
