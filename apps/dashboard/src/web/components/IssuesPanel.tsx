import type { DashboardIssue } from '../../contracts.js';
import { Badge } from './common.js';
export function IssuesPanel({ issues }: { issues: DashboardIssue[] }) {
  return (
    <section>
      <h2>Errors & degraded state</h2>
      {issues.length ? (
        <ul className="issues">
          {issues.map((issue) => (
            <li key={JSON.stringify(issue)}>
              <Badge value={issue.kind} />
              <strong>{issue.code}</strong>
              <p>{issue.message}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No issues reported by the available sources.</p>
      )}
    </section>
  );
}
