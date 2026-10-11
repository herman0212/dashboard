import type { WorkflowProgress, WorkflowStage } from '../../contracts.js';
import { Badge, Duration } from './common.js';

function Lane({ title, stages }: { title: string; stages: WorkflowStage[] }) {
  return (
    <div className="lane">
      <h3>{title}</h3>
      <ol>
        {stages.map((stage) => (
          <li key={stage.id}>
            <div>
              <strong>{stage.label}</strong>
              <Badge value={stage.participation.value === 'disabled' ? 'disabled' : stage.status.value} />
            </div>
            <small>{stage.id}</small>
            {stage.durationMs.value !== null ? (
              <small>
                <Duration ms={stage.durationMs.value} />
              </small>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}
export function WorkflowTimeline({ progress }: { progress: WorkflowProgress }) {
  const capella = progress.stages.filter((s) => s.lane === 'capella');
  const pentest = progress.stages.filter((s) => s.lane === 'pentest');
  const presentationOrder = (stage: WorkflowStage) => {
    if (stage.id === 'validate-authentication') return 1;
    if (stage.id === 'pre-recon') return 2;
    if (stage.id === 'recon') return 3;
    if (stage.id === 'injection-vuln') return 4;
    if (stage.id.startsWith('reconciliation')) return 5;
    if (stage.id === 'queue-check') return 6;
    if (stage.id === 'injection-exploit') return 7;
    return stage.id.startsWith('preflight') ||
      stage.id.startsWith('scan-') ||
      stage.id.startsWith('resume-') ||
      stage.id === 'durable-state'
      ? 0
      : 8;
  };
  pentest.sort((a, b) => presentationOrder(a) - presentationOrder(b));
  return (
    <section>
      <div className="section-head">
        <h2>Workflow progress</h2>
        <span className="muted">
          Resolved agents: {progress.processedAgents.value ?? 'Unknown'} / {progress.expectedAgents.value ?? 'Unknown'}
        </span>
      </div>
      <p className="muted">
        Resolved = completed + explicitly skipped expected agents. Stage durations and remaining work differ.
      </p>
      <div className="lanes">
        <Lane title="Pentest" stages={pentest} />
        <Lane title="Reporting" stages={progress.stages.filter((s) => s.lane === 'reporting')} />
        {progress.capella.value && progress.capella.value.status !== 'disabled' ? (
          <div>
            <Badge value={progress.capella.value.status} />
            <Lane title="Capella · static analysis" stages={capella} />
            <p className="muted">Static confirmation does not demonstrate exploitation.</p>
          </div>
        ) : null}
      </div>
    </section>
  );
}
