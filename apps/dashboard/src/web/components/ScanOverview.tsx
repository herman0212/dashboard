import type { ScanSummary } from '../../contracts.js';
import { Badge, Duration, Value } from './common.js';
export function ScanOverview({ scan }: { scan: ScanSummary }) {
  return (
    <section>
      <div className="section-head">
        <h2>Scan overview</h2>
        <Badge value={scan.identityStatus} />
      </div>
      <div className="stat-grid">
        <div>
          <span>Execution status</span>
          <Badge value={scan.executionStatus.value} />
        </div>
        <div>
          <span>Business status</span>
          <Badge value={scan.businessStatus.value} />
        </div>
        <div>
          <span>Current phase</span>
          <Value fact={scan.currentPhase} />
        </div>
        <div>
          <span>Current agent</span>
          <Value fact={scan.currentAgent} />
        </div>
        <div>
          <span>Elapsed</span>
          <Duration ms={scan.elapsedMs.value} />
        </div>
        <div>
          <span>Report lifecycle</span>
          <Badge value={scan.reportLifecycle.value} />
        </div>
      </div>
      <dl className="identity">
        <dt>Target</dt>
        <dd>
          <Value fact={scan.target} />
        </dd>
        <dt>Workflow</dt>
        <dd>
          <Value fact={scan.workflowId} />
        </dd>
        <dt>Run</dt>
        <dd>
          <Value fact={scan.runId} />
        </dd>
        <dt>Observed</dt>
        <dd>{scan.lastUpdated}</dd>
      </dl>
      {scan.activeAgentNames.value?.length ? <p>Active agents: {scan.activeAgentNames.value.join(', ')}</p> : null}
    </section>
  );
}
