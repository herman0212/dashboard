import type { ApiResponse, DashboardIssue, ResponseMeta, ScanDetail } from '../contracts.js';
import type { DashboardConfig } from './config.js';
import { pipelineState, projectScan } from './projection.js';
import { readLogs } from './readers/log-reader.js';
import { fact, type ReportRead, readReport } from './readers/report-reader.js';
import { readTemporal, type TemporalRead } from './readers/temporal-reader.js';
import { listWorkspaceNames, readWorkspace, type WorkspaceRead } from './readers/workspace-reader.js';
import { digest, HttpError } from './security.js';
export interface Snapshot {
  workspace: WorkspaceRead;
  temporal: TemporalRead;
  report: ReportRead;
  detail: ScanDetail;
  meta: ResponseMeta;
}
export type TemporalReader = (id: string) => Promise<TemporalRead>;
export function metadata(
  sources: ResponseMeta['sources'] = [],
  issues: DashboardIssue[] = [],
  revision?: string,
): ResponseMeta {
  const now = new Date().toISOString();
  return {
    schemaVersion: '1',
    snapshotId: revision ?? digest(JSON.stringify(sources)),
    generatedAt: now,
    health: sources.some((s) => s.health === 'stale')
      ? 'stale'
      : sources.length > 0 && sources.every((s) => s.health === 'unavailable')
        ? 'unavailable'
        : sources.some((s) => s.health === 'partial' || s.health === 'unavailable')
          ? 'partial'
          : 'fresh',
    sources,
    issues,
  };
}
/** Limit Temporal reads across requests (including scan-list requests). */
function limitedReader(reader: TemporalReader): TemporalReader {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async (id) => {
    if (active >= 4) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try {
      return await reader(id);
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}
export function createSnapshots(config: DashboardConfig, reader: TemporalReader = readTemporal) {
  const temporalReader = limitedReader(reader);
  const pending = new Map<string, Promise<Snapshot>>();
  const cache = new Map<string, { snapshot: Snapshot; expires: number }>();
  const assertIdentity = (before: WorkspaceRead) => {
    const after = readWorkspace(config.workspaceRoot, before.name);
    if (after.identityRevision !== before.identityRevision)
      throw new HttpError(409, 'ExecutionChanged', 'Workspace was resumed while reading. Refresh this scan.', true);
    return after;
  };
  const get = async (name: string): Promise<Snapshot> => {
    const workspace = readWorkspace(config.workspaceRoot, name);
    if (workspace.identityStatus === 'ambiguous')
      throw new HttpError(409, 'IdentityConflict', 'Workspace has multiple unregistered workflow candidates.');
    // Exact session claims are authoritative; duplicate claims must not silently pick a workspace.
    if (workspace.workflowId && workspace.identityStatus === 'confirmed') {
      for (const other of listWorkspaceNames(config.workspaceRoot)) {
        if (other === name) continue;
        const claim = readWorkspace(config.workspaceRoot, other);
        if (claim.workflowId === workspace.workflowId)
          throw new HttpError(409, 'IdentityConflict', 'Multiple workspaces claim this workflow identity.');
      }
    }
    const key = `${name}|${workspace.identityRevision}`;
    const previous = cache.get(key);
    if (previous && previous.expires > Date.now()) return previous.snapshot;
    const running = pending.get(key);
    if (running) return running;
    const work = (async (): Promise<Snapshot> => {
      const temporal = workspace.workflowId
        ? await temporalReader(workspace.workflowId)
        : { execution: null, health: 'unavailable' as const, observedAt: null, reasonCode: 'IdentityUnconfirmed' };
      const refreshed = assertIdentity(workspace);
      const state = pipelineState(temporal.execution?.progress);
      const report = await readReport(refreshed, state, temporal);
      assertIdentity(refreshed);
      const detail = projectScan(refreshed, temporal, report);
      try {
        const logs = readLogs(refreshed, new URLSearchParams({ limit: '200' }));
        for (const agent of detail.agents.agents) {
          const latest = logs.entries.filter((entry) => entry.agent === agent.name).at(-1);
          if (latest)
            agent.latestKnownActivity = fact(
              {
                eventId: latest.id,
                timestamp: latest.timestamp,
                kind: latest.event === 'tool' ? 'tool' : latest.event === 'delegation' ? 'delegation' : 'lifecycle',
                message: latest.message,
                reference: latest.reference,
              },
              [latest.reference],
            );
        }
      } catch {
        /* Logs cannot establish current execution/agent status. */
      }
      const revision = digest(
        JSON.stringify({
          identity: refreshed.identityRevision,
          runId: temporal.execution?.runId,
          execution: temporal.execution?.status,
          state: state && {
            status: state.status,
            currentPhase: state.currentPhase,
            completed: state.completedAgents,
            skipped: state.skippedAgents,
            operations: state.operationalStages,
            report: state.reportProgress,
            partialReasons: state.partialReasons,
          },
          pending: temporal.execution?.pending,
          durable: refreshed.durable,
          session: refreshed.sessionDigest,
          report: { integrity: report.response.integrity, checkpoint: report.checkpoint },
        }),
      );
      const snapshot = {
        workspace: refreshed,
        temporal,
        report,
        detail,
        meta: metadata(detail.summary.sourceHealth, detail.summary.issues, revision),
      };
      cache.set(key, { snapshot, expires: Date.now() + 1500 });
      if (cache.size > 128) {
        const first = cache.keys().next().value;
        if (first) cache.delete(first);
      }
      return snapshot;
    })();
    pending.set(key, work);
    try {
      return await work;
    } finally {
      pending.delete(key);
    }
  };
  return {
    get,
    assertIdentity,
    response: <T>(snapshot: Snapshot, data: T): ApiResponse<T> => ({ data, meta: snapshot.meta }),
  };
}
