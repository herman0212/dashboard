/** Dashboard read facade: deliberately excludes lifecycle controls and workspace writers. */

export { getWorkspacesDir } from './home.js';
export { isPendingWorkflowIdentity } from './pending-workflow.js';
export { ACTIVITY_TO_PROGRESS, PIPELINE } from './scan/pipeline.js';
export type { DashboardExecution, DashboardPendingActivity } from './temporal-client.js';
export { closeDashboardConnection, readDashboardExecution } from './temporal-client.js';

/** Same latest-resume selection as resolveWorkflowId, over an already safely read record. */
export function dashboardWorkflowIdentity(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const session = (value as { session?: Record<string, unknown> }).session;
  if (!session || typeof session !== 'object') return null;
  const attempts = session.resumeAttempts;
  const latest = Array.isArray(attempts) ? (attempts.at(-1) as { workflowId?: unknown } | undefined) : undefined;
  const id = latest?.workflowId ?? session.originalWorkflowId;
  return typeof id === 'string' &&
    id.length > 0 &&
    id.length <= 512 &&
    !Array.from(id).some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127)
    ? id
    : null;
}
