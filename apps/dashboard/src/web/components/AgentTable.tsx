import type { AgentStatus } from '../../contracts.js';
import { Badge, Duration } from './common.js';
export function AgentTable({ agents }: { agents: AgentStatus[] }) {
  return (
    <section>
      <h2>Agent activity</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Agent</th>
              <th>Phase</th>
              <th>Status</th>
              <th>Activity / attempt</th>
              <th>Timing</th>
              <th>Metrics</th>
              <th>Latest known activity</th>
            </tr>
          </thead>
          <tbody>
            {agents.map((agent) => (
              <tr key={agent.name}>
                <td>
                  <strong>{agent.name}</strong>
                </td>
                <td>{agent.phase ?? 'Unknown'}</td>
                <td>
                  <Badge value={agent.status.value} />
                  {agent.status.health === 'stale' ? <Badge value="stale" /> : null}
                </td>
                <td>
                  {agent.activityState.value ?? 'Unknown'}
                  <br />
                  Attempt {agent.attempt.value ?? 'Unknown'}
                </td>
                <td>
                  <Duration ms={agent.elapsedMs.value ?? agent.metrics.value?.values.durationMs} />
                  <small>Started: {agent.startedAt.value ?? 'Unknown'}</small>
                </td>
                <td>
                  {agent.metrics.value?.values.costUsd != null
                    ? `$${agent.metrics.value.values.costUsd.toFixed(4)}`
                    : 'Cost unknown'}
                  <small>Turns: {agent.metrics.value?.values.numTurns ?? 'Unknown'}</small>
                </td>
                <td>
                  {agent.latestKnownActivity.value?.message ?? 'Unknown'}
                  <small>{agent.latestKnownActivity.value?.timestamp ?? ''}</small>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted">Log activity is historical evidence. Running status requires a started Temporal activity.</p>
    </section>
  );
}
