import type { DashboardArtifact, DeliverablesResponse } from '../../contracts.js';
import { usePolling } from '../usePolling.js';
import { Badge, ReadState, Reference } from './common.js';
export function ArtifactLink({ artifact }: { artifact: DashboardArtifact }) {
  return artifact.download.available && artifact.download.url ? (
    <a href={artifact.download.url}>Download sanitized</a>
  ) : (
    <span className="muted">{artifact.download.reasonCode ?? 'Unavailable'}</span>
  );
}
export function DeliverablesPanel({ workspace, revision }: { workspace: string; revision: string }) {
  const read = usePolling<DeliverablesResponse>(
    `/api/scans/${encodeURIComponent(workspace)}/deliverables`,
    0,
    revision,
  );
  return (
    <section>
      <div className="section-head">
        <h2>Deliverables</h2>
        <button type="button" onClick={read.refresh}>
          Refresh
        </button>
      </div>
      <ReadState loading={!read.response && !read.error} error={read.error} stale={read.stale} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Artifact</th>
              <th>Status</th>
              <th>Integrity</th>
              <th>Size</th>
              <th>Publication</th>
            </tr>
          </thead>
          <tbody>
            {read.response?.data?.artifacts.map((artifact) => (
              <tr key={artifact.artifactId}>
                <td>
                  <strong>{artifact.filename}</strong>
                  <small>{artifact.role}</small>
                  <Reference refs={artifact.provenance} />
                </td>
                <td>
                  <Badge value={artifact.status} />
                </td>
                <td>{artifact.verification}</td>
                <td>{artifact.size == null ? 'Unknown' : `${artifact.size.toLocaleString()} B`}</td>
                <td>
                  <ArtifactLink artifact={artifact} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted">
        Integrity does not establish secret-safe publication. Raw intermediate files and PDF downloads are blocked in
        this MVP.
      </p>
    </section>
  );
}
