import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiErrorResponse, Page, ScanSummary } from '../contracts.js';
import type { DashboardConfig } from './config.js';
import { decodeCursor, encodeCursor, pageLimit } from './cursor.js';
import { artifactPayload, readArtifacts } from './readers/artifact-reader.js';
import { projectFindings, readFindingCollections } from './readers/finding-reader.js';
import { readLogs } from './readers/log-reader.js';
import { listWorkspaceNames } from './readers/workspace-reader.js';
import { digest, HttpError, identifier } from './security.js';
import { createSnapshots, metadata, type TemporalReader } from './snapshot.js';

const allowedQueries: Record<string, string[]> = {
  scans: ['cursor', 'limit'],
  detail: [],
  findings: ['source', 'severity', 'confidence', 'outcome', 'q', 'cursor', 'limit'],
  logs: ['agent', 'phase', 'level', 'q', 'cursor', 'direction', 'limit'],
  deliverables: [],
  report: [],
  artifacts: [],
};
export function sendJson(response: ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(data));
}
export function apiRoutes(config: DashboardConfig, temporalReader?: TemporalReader) {
  const snapshots = createSnapshots(config, temporalReader);
  // Bounded cache of artifact references observed in responses, not an execution datastore.
  const observedArtifacts = new Map<string, { workspace: string; slotKey: string }>();
  return async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> => {
    if (request.method !== 'GET') throw new HttpError(405, 'ReadOnly', 'Dashboard API only supports GET.');
    const segments = url.pathname
      .split('/')
      .filter(Boolean)
      .map((v) => {
        try {
          return decodeURIComponent(v);
        } catch {
          throw new HttpError(400, 'InvalidEncoding', 'Invalid URL encoding.');
        }
      });
    if (segments[0] !== 'api' || segments[1] !== 'scans')
      throw new HttpError(404, 'RouteNotFound', 'API route does not exist.');
    const kind = segments.length === 2 ? 'scans' : segments.length === 3 ? 'detail' : (segments[3] ?? '');
    if (!allowedQueries[kind] || (kind === 'artifacts' ? segments.length !== 5 : segments.length > 4))
      throw new HttpError(404, 'RouteNotFound', 'API route does not exist.');
    for (const [key] of url.searchParams)
      if (!allowedQueries[kind]?.includes(key) || url.searchParams.getAll(key).length !== 1)
        throw new HttpError(400, 'InvalidQuery', 'Unknown or repeated query parameter.');
    if (kind === 'scans') {
      const names = listWorkspaceNames(config.workspaceRoot);
      const revision = digest(names.join('|'));
      const cursor = decodeCursor(url.searchParams.get('cursor'), 'scans', 'scans');
      if (cursor && cursor.revision !== revision)
        throw new HttpError(409, 'DatasetChanged', 'Workspace list changed. Refresh the list.', true);
      const limit = pageLimit(url.searchParams.get('limit'), 50, 200);
      const offset = cursor?.offset ?? 0;
      const items: ScanSummary[] = [];
      const sources: ScanSummary['sourceHealth'] = [];
      const issues: ScanSummary['issues'] = [];
      // Sequential list traversal keeps disk/Git work bounded; Temporal requests deduplicate globally.
      for (const name of names.slice(offset, offset + limit)) {
        try {
          const s = await snapshots.get(name);
          items.push(s.detail.summary);
          sources.push(...s.meta.sources);
        } catch (error) {
          if (error instanceof HttpError && error.status === 409)
            issues.push({
              kind: 'source-error',
              code: error.code,
              message: `Workspace ${name} has an identity conflict.`,
              references: [],
            });
          else
            issues.push({
              kind: 'source-error',
              code: 'WorkspaceUnavailable',
              message: `Workspace ${name} cannot be read safely.`,
              references: [],
            });
        }
      }
      const page: Page<ScanSummary> = {
        items,
        nextCursor:
          offset + limit < names.length
            ? encodeCursor({ kind: 'scans', scope: 'scans', revision, offset: offset + limit })
            : null,
        previousCursor: null,
        total: names.length,
        complete: issues.length === 0,
      };
      const now = new Date().toISOString();
      sendJson(response, 200, {
        data: page,
        meta: metadata(
          [
            {
              source: 'workspace-index',
              health: issues.length ? 'partial' : 'fresh',
              checkedAt: now,
              lastSuccessAt: now,
              reasonCode: null,
            },
            ...sources,
          ],
          issues,
          revision,
        ),
      });
      return;
    }
    const name = identifier(segments[2] ?? '');
    const snapshot = await snapshots.get(name);
    if (kind === 'detail') {
      sendJson(response, 200, snapshots.response(snapshot, snapshot.detail));
      return;
    }
    if (kind === 'logs') {
      const data = readLogs(snapshot.workspace, url.searchParams);
      snapshots.assertIdentity(snapshot.workspace);
      sendJson(response, 200, {
        data,
        meta: metadata(
          [
            ...snapshot.meta.sources,
            {
              source: 'logs',
              health: data.omittedCount > 0 ? 'partial' : 'fresh',
              checkedAt: new Date().toISOString(),
              lastSuccessAt: new Date().toISOString(),
              reasonCode: data.omittedCount > 0 ? 'LogLinesOmitted' : null,
            },
          ],
          snapshot.meta.issues,
          snapshot.meta.snapshotId,
        ),
      });
      return;
    }
    if (kind === 'findings') {
      const collections = await readFindingCollections(snapshot.workspace, snapshot.report);
      snapshots.assertIdentity(snapshot.workspace);
      const data = projectFindings(name, collections, url.searchParams);
      const coverage = data.coverage.filter((v) => data.selectedSources.includes(v.source));
      const health = coverage.every((v) => v.health === 'fresh')
        ? 'fresh'
        : coverage.every((v) => v.health === 'unavailable')
          ? 'unavailable'
          : 'partial';
      sendJson(response, 200, {
        data,
        meta: metadata(
          [
            ...snapshot.meta.sources,
            {
              source: 'findings',
              health,
              checkedAt: new Date().toISOString(),
              lastSuccessAt: health === 'fresh' ? new Date().toISOString() : null,
              reasonCode: health === 'fresh' ? null : 'FindingSourcesIncomplete',
            },
          ],
          snapshot.meta.issues,
          snapshot.meta.snapshotId,
        ),
      });
      return;
    }
    const artifacts = await readArtifacts(snapshot.workspace, snapshot.report);
    snapshots.assertIdentity(snapshot.workspace);
    if (kind === 'artifacts') {
      const old = observedArtifacts.get(segments[4] ?? '');
      if (
        old?.workspace === name &&
        !artifacts.response.artifacts.some((artifact) => artifact.artifactId === segments[4])
      )
        throw new HttpError(409, 'ArtifactChanged', 'Artifact revision changed. Refresh the deliverables list.', true);
    }
    for (const artifact of artifacts.response.artifacts)
      observedArtifacts.set(artifact.artifactId, { workspace: name, slotKey: `${artifact.role}|${artifact.filename}` });
    while (observedArtifacts.size > 5000) {
      const first = observedArtifacts.keys().next().value;
      if (first) observedArtifacts.delete(first);
    }
    const artifactMeta = metadata(
      [
        ...snapshot.meta.sources,
        {
          source: 'artifacts',
          health: artifacts.response.complete ? 'fresh' : 'partial',
          checkedAt: new Date().toISOString(),
          lastSuccessAt: artifacts.response.complete ? new Date().toISOString() : null,
          reasonCode: artifacts.response.complete ? null : 'ArtifactsIncomplete',
        },
      ],
      snapshot.meta.issues,
      snapshot.meta.snapshotId,
    );
    if (kind === 'deliverables') {
      sendJson(response, 200, { data: artifacts.response, meta: artifactMeta });
      return;
    }
    if (kind === 'report') {
      sendJson(response, 200, { data: snapshot.report.response, meta: artifactMeta });
      return;
    }
    if (kind === 'artifacts') {
      const payload = artifactPayload(artifacts, segments[4] ?? '');
      response.writeHead(200, {
        'content-type': payload.mime,
        'content-disposition': `attachment; filename="${payload.filename}"`,
        'content-length': payload.bytes.length,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'x-content-sha256': digest(payload.bytes),
      });
      response.end(payload.bytes);
      return;
    }
    throw new HttpError(404, 'RouteNotFound', 'API route does not exist.');
  };
}
export function apiError(response: ServerResponse, error: unknown): void {
  const e =
    error instanceof HttpError
      ? error
      : new HttpError(503, 'SourceUnavailable', 'A data source could not be read safely.', true);
  const body: ApiErrorResponse = {
    error: { code: e.code, message: e.message, retryable: e.retryable },
    meta: metadata([
      {
        source: 'workspace-index',
        health: 'unavailable',
        checkedAt: new Date().toISOString(),
        lastSuccessAt: null,
        reasonCode: e.code,
      },
    ]),
  };
  sendJson(response, e.status, body);
}
