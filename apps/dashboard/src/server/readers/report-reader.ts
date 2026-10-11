import type { PipelineState, ReportProgress } from '@astra/worker/dashboard-contracts';
import {
  draftProgressIsCoherent,
  finalProgressIsCoherent,
  isReportProgress,
  REPORT_JSON_FILENAME,
  withCheckpointGitReader,
} from '@astra/worker/dashboard-read';
import type { DataReference, Fact, ReportResponse } from '../../contracts.js';
import { digest, iso, record, safeUrl, sanitizeText } from '../security.js';
import { assertDeliverablesGit, deliverablesSlot, readGit } from './git-read.js';
import type { TemporalRead } from './temporal-reader.js';
import type { WorkspaceRead } from './workspace-reader.js';
export interface ReportRead {
  response: ReportResponse;
  progress: ReportProgress | null;
  checkpoint: string | null;
  raw: Record<string, unknown> | null;
  sourceDigest: string | null;
  slot: string | null;
}
export function reference(source: DataReference['source'], fields: Partial<DataReference> = {}): DataReference {
  return {
    source,
    scope: 'workspace',
    workflowId: null,
    runId: null,
    artifactId: null,
    checkpoint: null,
    sha256: null,
    jsonPointer: null,
    lineRange: null,
    ...fields,
  };
}
export function fact<T>(
  value: T | null,
  refs: DataReference[] = [],
  observedAt: string | null = new Date().toISOString(),
  health: Fact<T>['health'] = value === null ? 'unavailable' : 'fresh',
  reasonCode: string | null = value === null ? 'NoEvidence' : null,
): Fact<T> {
  return { value, health, observedAt: value === null ? null : observedAt, references: refs, reasonCode };
}
export async function readReport(
  ws: WorkspaceRead,
  state: PipelineState | null,
  temporal?: TemporalRead,
): Promise<ReportRead> {
  const candidate = state?.reportProgress ?? ws.report;
  const progress =
    candidate && isReportProgress(candidate, state?.participatingClasses ?? ws.durable?.participating_classes ?? [])
      ? candidate
      : null;
  const lifecycleRefs = state?.reportProgress
    ? [
        reference(temporal?.execution?.progressSource === 'result' ? 'temporal-result' : 'temporal-progress', {
          scope: 'execution',
          workflowId: ws.workflowId,
          runId: temporal?.execution?.runId ?? null,
          jsonPointer: '/reportProgress',
        }),
      ]
    : [reference('session', { sha256: ws.sessionDigest, jsonPointer: '/durableScanState/report' })];
  const refs = [...lifecycleRefs];
  let integrity: ReportResponse['integrity'] = progress ? 'unverified' : 'unavailable';
  let checkpoint: string | null = null;
  let raw: Record<string, unknown> | null = null;
  let sourceDigest: string | null = null;
  let slot: string | null = null;
  try {
    slot = deliverablesSlot(ws.root);
    if (slot && progress && progress.stage !== 'pending') {
      const dir = assertDeliverablesGit(ws.root, slot);
      const coherent = await withCheckpointGitReader(
        async (directory, args) => {
          try {
            return { exitCode: 0, stdout: await readGit(directory, [...args]), stderr: '' };
          } catch (error) {
            const failure = record(error);
            if (typeof failure.code !== 'number') throw error;
            return {
              exitCode: failure.code,
              stdout: typeof failure.stdout === 'string' ? failure.stdout : '',
              stderr: typeof failure.stderr === 'string' ? failure.stderr : '',
            };
          }
        },
        () =>
          progress.stage === 'finalized'
            ? finalProgressIsCoherent(dir, progress)
            : draftProgressIsCoherent(dir, progress),
      );
      integrity = coherent ? 'verified' : 'invalid';
      if (coherent) {
        checkpoint =
          progress.stage === 'finalized'
            ? progress.final_checkpoint
            : (progress.canonical_checkpoint ?? progress.model_checkpoint);
        const bytes = await readGit(dir, ['show', `${checkpoint}:${REPORT_JSON_FILENAME}`]);
        raw = record(JSON.parse(bytes));
        sourceDigest = digest(bytes);
        refs.push(
          reference('report-proof', {
            scope: 'artifact',
            checkpoint,
            sha256: sourceDigest,
            jsonPointer: '/report_meta',
          }),
        );
      }
    }
  } catch {
    integrity = 'unavailable';
  }
  const meta = record(raw?.report_meta);
  const coverage = record(meta.coverage);
  const limitations = Array.isArray(coverage.limitations)
    ? coverage.limitations.map((item) => {
        const v = record(item);
        return { code: sanitizeText(v.code, 100) ?? 'unknown', message: sanitizeText(v.message) ?? 'Unavailable' };
      })
    : [];
  return {
    progress,
    checkpoint,
    raw,
    sourceDigest,
    slot,
    response: {
      lifecycle: fact(
        progress?.stage ?? null,
        lifecycleRefs,
        temporal?.observedAt ?? new Date().toISOString(),
        state?.reportProgress ? (temporal?.health ?? 'fresh') : progress ? 'fresh' : 'unavailable',
      ),
      integrity,
      mode: fact(meta.exploit === true ? 'exploits' : meta.exploit === false ? 'findings' : null, refs),
      target: fact(safeUrl(meta.target), refs),
      assessmentDate: fact(iso(meta.assessment_date), refs),
      scope: fact(sanitizeText(meta.scope), refs),
      executiveSummary: fact(sanitizeText(meta.executive_summary, 16000), refs),
      coverage: fact(
        typeof coverage.status === 'string' && ['complete', 'partial'].includes(coverage.status)
          ? { status: coverage.status, limitations }
          : null,
        refs,
      ),
      modelCheckpoint: fact(progress && progress.stage !== 'pending' ? progress.model_checkpoint : null, refs),
      canonicalCheckpoint: fact(
        progress && progress.stage !== 'pending' ? (progress.canonical_checkpoint ?? null) : null,
        refs,
      ),
      finalCheckpoint: fact(progress?.stage === 'finalized' ? progress.final_checkpoint : null, refs),
      outputs: { json: null, markdown: null, pdf: null, sarif: null },
    },
  };
}
