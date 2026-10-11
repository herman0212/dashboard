import fs from 'node:fs';
import path from 'node:path';
import type { DurableScanState, ReportProgress } from '@astra/worker/dashboard-contracts';
import { isDurableScanState } from '@astra/worker/dashboard-read';
import { dashboardWorkflowIdentity, isPendingWorkflowIdentity } from '@keygraph/astra/dashboard-read';
import { digest, HttpError, identifier, missing, optionalRead, record, safePath, safeUrl } from '../security.js';
export interface WorkspaceRead {
  name: string;
  root: string;
  workflowId: string | null;
  identityStatus: 'confirmed' | 'pending-registration' | 'ambiguous' | 'unavailable';
  identityRevision: string;
  session: Record<string, unknown> | null;
  sessionDigest: string | null;
  target: string | null;
  durable: DurableScanState | null;
  report: ReportProgress | null;
  startupError: boolean;
  sessionUnavailable: boolean;
  externalOutputConfigured: boolean;
}
export function listWorkspaceNames(root: string): string[] {
  try {
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new HttpError(503, 'WorkspaceRootUnavailable', 'Workspace root is unavailable.');
    const entries = fs.readdirSync(root, { withFileTypes: true });
    if (entries.length > 2000)
      throw new HttpError(503, 'WorkspaceLimit', 'Workspace root exceeds the enumeration limit.');
    return entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => entry.name)
      .filter((name) => {
        try {
          identifier(name);
          return true;
        } catch {
          return false;
        }
      })
      .sort();
  } catch (error) {
    if (missing(error)) return [];
    throw error instanceof HttpError
      ? error
      : new HttpError(503, 'WorkspaceRootUnavailable', 'Workspace root cannot be read.', true);
  }
}
export function readWorkspace(root: string, name: string): WorkspaceRead {
  identifier(name);
  let resolved: string;
  try {
    resolved = safePath(root, name);
    if (!fs.statSync(resolved).isDirectory())
      throw new HttpError(404, 'WorkspaceNotFound', 'Workspace does not exist.');
  } catch (error) {
    if (missing(error)) throw new HttpError(404, 'WorkspaceNotFound', 'Workspace does not exist.');
    throw error;
  }
  let session: Record<string, unknown> | null = null;
  let sessionDigest: string | null = null;
  let sessionUnavailable = false;
  try {
    const file = optionalRead(resolved, ['.astra/session.json', 'session.json'], 2 * 1024 * 1024);
    if (file) {
      sessionDigest = digest(file.bytes);
      session = record(JSON.parse(file.bytes.toString('utf8')));
    }
  } catch {
    sessionUnavailable = true;
  }
  const workflowId = dashboardWorkflowIdentity(session);
  const durable = isDurableScanState(session?.durableScanState) ? session.durableScanState : null;
  const sessionMeta = record(session?.session);
  const candidates: string[] = [];
  try {
    const pending = safePath(resolved, '.astra/pending-workflows');
    for (const entry of fs.readdirSync(pending).slice(0, 100)) {
      if (!/^launch-[a-zA-Z0-9_.%~-]+\.json$/.test(entry)) continue;
      const file = optionalRead(resolved, [path.posix.join('.astra/pending-workflows', entry)], 64 * 1024);
      if (!file) continue;
      const value = record(JSON.parse(file.bytes.toString()));
      if (isPendingWorkflowIdentity(value, name, entry)) candidates.push(value.workflow_id);
    }
  } catch (error) {
    if (!missing(error)) sessionUnavailable = true;
  }
  const unique = [...new Set(candidates)];
  // Candidate identity is only usable for a describe; it is not proof of execution.
  const candidate = workflowId ?? (unique.length === 1 ? (unique[0] ?? null) : null);
  let startupError = false;
  let externalOutputConfigured = false;
  try {
    startupError = optionalRead(resolved, ['.astra/startup-error.json'], 64 * 1024) !== null;
  } catch {
    sessionUnavailable = true;
  }
  try {
    const launch = optionalRead(resolved, ['.astra/launch.json'], 64 * 1024);
    if (launch) {
      const value = record(JSON.parse(launch.bytes.toString()));
      if (
        value.schema_version !== 1 ||
        Object.keys(value).some((key) => !['schema_version', 'customer_output_path'].includes(key))
      )
        sessionUnavailable = true;
      else externalOutputConfigured = typeof value.customer_output_path === 'string';
    }
  } catch {
    sessionUnavailable = true;
  }
  return {
    name,
    root: resolved,
    workflowId: candidate,
    identityStatus: workflowId
      ? 'confirmed'
      : unique.length > 1
        ? 'ambiguous'
        : candidate
          ? 'pending-registration'
          : 'unavailable',
    identityRevision: digest(
      JSON.stringify({ workflowId, candidates: unique.sort(), sessionId: sessionMeta.id ?? null }),
    ),
    session,
    sessionDigest,
    target: safeUrl(sessionMeta.webUrl),
    durable,
    report: durable?.report ?? null,
    startupError,
    sessionUnavailable,
    externalOutputConfigured,
  };
}
