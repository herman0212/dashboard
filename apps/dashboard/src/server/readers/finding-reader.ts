import {
  exploitationQueuePath,
  getAgentGitPaths,
  isCapellaFinding,
  isCapellaRunRecord,
  isManifest,
  isManifestCoherent,
  isNormalizedRepositoryPath,
  parseCodePath,
  publicationContractForClass,
  reconciliationManifestPath,
} from '@astra/worker/dashboard-read';
import type {
  DashboardFinding,
  DataReference,
  FindingLocation,
  FindingSource,
  FindingStage,
  FindingsResponse,
} from '../../contracts.js';
import { decodeCursor, encodeCursor, pageLimit } from '../cursor.js';
import { digest, HttpError, number, optionalRead, record, safeUrl, sanitizeText } from '../security.js';
import { assertDeliverablesGit, readGit } from './git-read.js';
import type { ReportRead } from './report-reader.js';
import { reference } from './report-reader.js';
import type { WorkspaceRead } from './workspace-reader.js';
export const FINDING_SOURCES: FindingSource[] = [
  'analysis_queue',
  'exploitation_result',
  'reconciliation',
  'final_report',
  'capella',
];
export interface FindingCollection {
  stage?: FindingStage;
  source: FindingSource;
  items: DashboardFinding[];
  health: 'fresh' | 'partial' | 'unavailable';
  complete: boolean;
}
function token(value: unknown): string | null {
  return typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,180}$/.test(value) ? value : null;
}
function location(raw: Record<string, unknown>): FindingLocation | null {
  const candidate = raw.file ?? raw.workspace_relative_file_path;
  if (typeof candidate !== 'string' || !isNormalizedRepositoryPath(candidate)) return null;
  return {
    kind: 'code',
    file: sanitizeText(candidate, 2000),
    startLine: number(raw.start_line ?? raw.line_number ?? raw.line),
    endLine: number(raw.end_line),
    role: sanitizeText(raw.role, 100),
    symbol: sanitizeText(raw.symbol, 200),
    method: null,
    url: null,
    display: sanitizeText(candidate, 2000) ?? 'Location unavailable',
  };
}
/** Positive projection: unknown properties, prompts, tool arguments and credentials are excluded. */
export function normalizeFinding(
  workspace: string,
  source: FindingSource,
  stage: FindingStage,
  value: unknown,
  ref: DataReference,
  pointer: string,
  sourceStage: string | null = null,
): DashboardFinding {
  const raw = record(value);
  const nativeId = token(raw.finding_id ?? raw.vulnerability_id ?? raw.ID ?? raw.producer_id ?? raw.id);
  const version = ref.sha256 ?? digest(JSON.stringify(raw));
  const provenance = { ...ref, jsonPointer: pointer };
  const locations: FindingLocation[] = [];
  if (Array.isArray(raw.code_locations))
    for (const item of raw.code_locations.slice(0, 100)) {
      const v = location(record(item));
      if (v) locations.push(v);
    }
  if (Array.isArray(raw.code_paths))
    for (const item of raw.code_paths.slice(0, 100)) {
      if (typeof item !== 'string') continue;
      const parsed = parseCodePath(item);
      if (parsed) {
        const v = location({ file: parsed.file, line: parsed.line });
        if (v) locations.push(v);
      }
    }
  const sast = location(record(raw.sast_source_location));
  if (sast) locations.push(sast);
  const http = record(raw.http_location);
  const url = safeUrl(http.url);
  if (url)
    locations.push({
      kind: 'http',
      file: null,
      startLine: null,
      endLine: null,
      role: null,
      symbol: null,
      method: /^[A-Z]{2,12}$/.test(String(http.method)) ? String(http.method) : null,
      url,
      display: url,
    });
  const textual = sanitizeText(raw.vulnerable_location ?? raw.sink_call ?? raw.source, 2000);
  if (!locations.length && textual)
    locations.push({
      kind: 'text',
      file: null,
      startLine: null,
      endLine: null,
      role: null,
      symbol: null,
      method: null,
      url: null,
      display: textual,
    });
  const severity = typeof raw.severity === 'string' ? raw.severity.toLowerCase() : null;
  const confidence = typeof raw.confidence === 'string' ? raw.confidence.toLowerCase() : null;
  const allowedOutcome =
    source === 'capella'
      ? ['VALID', 'FALSE_POSITIVE', 'PROVISIONALLY_VALID', 'NEEDS_RESEARCH', 'DUPLICATE']
      : source === 'exploitation_result'
        ? ['exploited', 'blocked']
        : source === 'final_report'
          ? ['exploited', 'out_of_scope', 'blocked_by_constraints', 'false_positive']
          : [];
  const outcome =
    typeof raw.status === 'string' && allowedOutcome.includes(raw.status)
      ? { namespace: source, value: raw.status }
      : null;
  const confirmation =
    source === 'capella'
      ? raw.repro_status === 'statically_confirmed'
        ? 'static'
        : 'unknown'
      : outcome?.value === 'exploited'
        ? 'exploited'
        : 'unknown';
  const evidence = [
    'overview',
    'description',
    'impact',
    'potential_impact',
    'notes',
    'current_blocker',
    'evidence_of_vulnerability',
    'proof_of_impact',
  ].flatMap((field) => {
    const text = sanitizeText(raw[field]);
    return text
      ? [
          {
            kind: 'prose' as const,
            label: field.replaceAll('_', ' '),
            content: text,
            language: null,
            redacted: text !== raw[field],
            reference: provenance,
          },
        ]
      : [];
  });
  return {
    dashboardId: digest(`${workspace}|${source}|${ref.artifactId ?? ''}|${version}|${nativeId ?? pointer}`),
    identityScope: 'artifact-version',
    recordVersion: version,
    source,
    stage,
    sourceStage,
    findingId: nativeId,
    title: sanitizeText(raw.title, 300),
    vulnerabilityType: sanitizeText(raw.vulnerability_type, 150),
    category: sanitizeText(raw.category, 150),
    severity:
      severity && ['critical', 'high', 'medium', 'low'].includes(severity)
        ? (severity as DashboardFinding['severity'])
        : null,
    confidence:
      confidence && ['high', 'medium', 'low'].includes(confidence)
        ? (confidence as DashboardFinding['confidence'])
        : null,
    outcome,
    confirmation,
    locations,
    evidence,
    provenance: [provenance],
    relations: [],
  };
}
export async function readFindingCollections(ws: WorkspaceRead, report: ReportRead): Promise<FindingCollection[]> {
  const collections: FindingCollection[] = FINDING_SOURCES.map((source) => ({
    source,
    items: [],
    health: 'unavailable',
    complete: false,
  }));
  const collection = (source: FindingSource) => collections.find((v) => v.source === source) as FindingCollection;
  const add = (
    source: FindingSource,
    stage: FindingStage,
    rows: unknown[],
    ref: DataReference,
    pointer: string,
    sourceStage?: string,
  ) => {
    const target = collection(source);
    target.stage = stage;
    target.items.push(
      ...rows
        .slice(0, 10000)
        .map((item, i) => normalizeFinding(ws.name, source, stage, item, ref, `${pointer}/${i}`, sourceStage ?? null)),
    );
    target.health = rows.length > 10000 ? 'partial' : 'fresh';
    target.complete = rows.length <= 10000;
  };
  const slot = report.slot;
  if (slot) {
    try {
      const dir = assertDeliverablesGit(ws.root, slot);
      const head = (await readGit(dir, ['rev-parse', '--verify', 'HEAD'])).trim();
      const queuePath = exploitationQueuePath('injection');
      let manifest: unknown = null;
      let manifestContents: string | null = null;
      const manifestPath = reconciliationManifestPath('injection');
      const manifestAbsent = (await readGit(dir, ['ls-tree', '--name-only', head, '--', manifestPath])).trim() === '';
      try {
        if (!manifestAbsent) {
          manifestContents = await readGit(dir, ['show', `${head}:${manifestPath}`]);
          manifest = JSON.parse(manifestContents);
        }
      } catch {
        /* no confirmed publication */
      }
      const committedQueue = await readGit(dir, ['show', `${head}:${queuePath}`]).catch(() => null);
      if (committedQueue) {
        const parsed = record(JSON.parse(committedQueue));
        const rows = Array.isArray(parsed.vulnerabilities) ? parsed.vulnerabilities : null;
        if (rows) {
          if (
            isManifest(manifest) &&
            isManifestCoherent({
              manifest,
              sessionId: ws.name,
              vulnerabilityClass: 'injection',
              contract: publicationContractForClass('injection', manifest.consumer_files.length > 1),
              producerQueuePath: queuePath,
            })
          ) {
            const consumer = manifest.consumer_files.find((v) => v.path === queuePath);
            let consumersVerified = consumer?.sha256 === digest(committedQueue);
            for (const file of manifest.consumer_files) {
              if (file.path === queuePath) continue;
              const contents = await readGit(dir, ['show', `${head}:${file.path}`]).catch(() => null);
              if (contents === null || digest(contents) !== file.sha256) consumersVerified = false;
            }
            const lineageVerified =
              rows.length === Object.keys(manifest.lineage).length &&
              rows.every(
                (item) =>
                  typeof record(item).ID === 'string' && Object.hasOwn(manifest.lineage, String(record(item).ID)),
              );
            if (consumersVerified && lineageVerified) {
              add(
                'reconciliation',
                'reconciliation',
                rows,
                reference('findings', {
                  scope: 'artifact',
                  artifactId: digest(queuePath + head),
                  checkpoint: head,
                  sha256: digest(committedQueue),
                }),
                '/vulnerabilities',
                'published',
              );
              const published = collection('reconciliation');
              for (const item of published.items) {
                const lineage = item.findingId ? manifest.lineage[item.findingId] : null;
                if (lineage)
                  item.provenance.push(
                    reference('findings', {
                      scope: 'artifact',
                      checkpoint: head,
                      sha256: manifestContents ? digest(manifestContents) : null,
                      jsonPointer: `/lineage/${item.findingId}`,
                    }),
                  );
              }
            } else collection('reconciliation').health = 'partial';
            const producer = await readGit(dir, ['cat-file', 'blob', manifest.producer_queue.blob_sha]).catch(
              () => null,
            );
            if (producer) {
              const data = record(JSON.parse(producer));
              if (Array.isArray(data.vulnerabilities))
                add(
                  'analysis_queue',
                  'analysis',
                  data.vulnerabilities,
                  reference('findings', {
                    scope: 'artifact',
                    artifactId: digest(queuePath + manifest.producer_queue.blob_sha),
                    sha256: digest(producer),
                  }),
                  '/vulnerabilities',
                );
            }
          } else if (manifestAbsent)
            add(
              'analysis_queue',
              'analysis',
              rows,
              reference('findings', {
                scope: 'artifact',
                artifactId: digest(queuePath + head),
                checkpoint: head,
                sha256: digest(committedQueue),
              }),
              '/vulnerabilities',
            );
          else collection('reconciliation').health = 'partial';
        }
      }
      const collector = getAgentGitPaths('injection-exploit').find((name) => name.endsWith('_collector.json'));
      if (collector) {
        const contents = await readGit(dir, ['show', `${head}:${collector}`]).catch(() => null);
        if (contents) {
          const value: unknown = JSON.parse(contents);
          if (Array.isArray(value))
            add(
              'exploitation_result',
              'exploitation',
              value,
              reference('findings', {
                scope: 'artifact',
                artifactId: digest(collector + head),
                checkpoint: head,
                sha256: digest(contents),
              }),
              '',
            );
        }
      }
    } catch {
      /* failed source remains unavailable; absence is not zero findings */
    }
  }
  if (report.raw && Array.isArray(report.raw.findings)) {
    add(
      'final_report',
      report.progress?.stage === 'finalized' ? 'report-finalized' : 'report-draft',
      report.raw.findings,
      reference('report-proof', {
        scope: 'artifact',
        checkpoint: report.checkpoint,
        sha256: report.sourceDigest,
        artifactId: digest(`report.json${report.checkpoint}`),
      }),
      '/findings',
    );
  }
  try {
    const runFile = optionalRead(ws.root, ['.astra/capella/run.json'], 2 * 1024 * 1024);
    const run = runFile ? record(JSON.parse(runFile.bytes.toString())) : {};
    if (isCapellaRunRecord(run)) {
      for (const stage of ['calibrate', 'confirm', 'critic', 'review', 'dedupe', 'research'] as const) {
        if (!run.completedStages.includes(stage)) continue;
        const file = optionalRead(ws.root, [`.astra/capella/stages/${stage}.json`]);
        if (!file) continue;
        const envelope = record(JSON.parse(file.bytes.toString()));
        const value = record(envelope.value);
        if (
          envelope.schemaVersion !== 1 ||
          envelope.stage !== stage ||
          typeof envelope.fingerprint !== 'string' ||
          !Array.isArray(value.findings)
        )
          continue;
        const findings = value.findings;
        add(
          'capella',
          'sast',
          findings,
          reference('findings', {
            scope: 'artifact',
            artifactId: digest(`capella/${stage}${digest(file.bytes)}`),
            sha256: digest(file.bytes),
          }),
          '/value/findings',
          stage,
        );
        collection('capella').items = collection('capella').items.filter((_, index) =>
          isCapellaFinding(findings[index]),
        );
        // Saved stage evidence is workspace-scoped. run.json does not bind a workflow/runId,
        // and recomputing its fingerprint would require private prompts/config. Do not claim currency.
        collection('capella').health = 'partial';
        collection('capella').complete = false;
        break;
      }
    }
  } catch {
    /* quarantined/malformed data is not published */
  }
  return collections;
}
export function projectFindings(
  ws: string,
  collections: FindingCollection[],
  query: URLSearchParams,
): FindingsResponse {
  const selected = query.get('source')?.split(',') as FindingSource[] | undefined;
  if (selected?.some((v) => !FINDING_SOURCES.includes(v)))
    throw new HttpError(400, 'InvalidSource', 'Unknown finding source.');
  const chosen = [
    ...new Set(
      selected ?? [
        collections.find((v) => v.source === 'final_report' && v.complete && v.stage === 'report-finalized')?.source ??
          collections.find((v) => v.source === 'reconciliation' && v.complete)?.source ??
          'analysis_queue',
      ],
    ),
  ];
  const severity = query.get('severity');
  const confidence = query.get('confidence');
  if (severity && !['critical', 'high', 'medium', 'low', 'unknown'].includes(severity))
    throw new HttpError(400, 'InvalidSeverity', 'Unknown severity.');
  if (confidence && !['high', 'medium', 'low', 'unknown'].includes(confidence))
    throw new HttpError(400, 'InvalidConfidence', 'Unknown confidence.');
  const q = (query.get('q') ?? '').toLowerCase();
  if (q.length > 200) throw new HttpError(400, 'QueryLimit', 'Search is too long.');
  const data = collections.filter((v) => chosen.includes(v.source)).flatMap((v) => v.items);
  const revision = digest(data.map((v) => v.dashboardId).join('|'));
  const scope = `${ws}|${chosen.join(',')}|${severity}|${confidence}|${query.get('outcome')}|${q}`;
  const cursor = decodeCursor(query.get('cursor'), 'findings', scope);
  if (cursor && cursor.revision !== revision)
    throw new HttpError(409, 'DatasetChanged', 'Findings changed. Refresh the first page.', true);
  const filtered = data.filter(
    (v) =>
      (!severity || (v.severity ?? 'unknown') === severity) &&
      (!confidence || (v.confidence ?? 'unknown') === confidence) &&
      (!query.get('outcome') || v.outcome?.value === query.get('outcome')) &&
      (!q || JSON.stringify([v.findingId, v.title, v.locations, v.evidence]).toLowerCase().includes(q)),
  );
  const offset = cursor?.offset ?? 0;
  const limit = pageLimit(query.get('limit'), 50, 200);
  const next =
    offset + limit < filtered.length
      ? encodeCursor({ kind: 'findings', scope, revision, offset: offset + limit })
      : null;
  return {
    selectedSources: chosen,
    page: {
      items: filtered.slice(offset, offset + limit),
      nextCursor: next,
      previousCursor: null,
      total: chosen.every((s) => collections.find((v) => v.source === s)?.complete) ? filtered.length : null,
      complete: chosen.every((s) => collections.find((v) => v.source === s)?.complete),
    },
    coverage: collections.map((v) => ({
      source: v.source,
      health: v.health,
      complete: v.complete,
      count: v.complete ? v.items.length : null,
    })),
  };
}
