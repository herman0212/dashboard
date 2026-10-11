import {
  ALL_AGENTS,
  ASSEMBLED_REPORT_FILENAME,
  ASSEMBLED_REPORT_PDF_FILENAME,
  FINAL_REPORT_MD_FILENAME,
  FINAL_REPORT_PDF_FILENAME,
  getAgentGitPaths,
  isNormalizedRepositoryPath,
  publicationContractForClass,
  REPORT_FINALIZATION_MANIFEST_FILENAME,
  REPORT_JSON_FILENAME,
  SARIF_FILENAME,
} from '@astra/worker/dashboard-read';
import type { DashboardArtifact, DeliverablesResponse } from '../../contracts.js';
import { digest, HttpError, identifier, missing, optionalRead, record, sanitizeText } from '../security.js';
import { normalizeFinding } from './finding-reader.js';
import { assertDeliverablesGit, readGit } from './git-read.js';
import type { ReportRead } from './report-reader.js';
import { reference } from './report-reader.js';
import type { WorkspaceRead } from './workspace-reader.js';
export interface ArtifactRead {
  response: DeliverablesResponse;
  payloads: Map<string, { bytes: Buffer; mime: string; filename: string }>;
}
function extension(name: string): DashboardArtifact['type'] {
  return name.endsWith('.pdf')
    ? 'pdf'
    : name.endsWith('.md')
      ? 'markdown'
      : name.endsWith('.sarif')
        ? 'sarif'
        : name.endsWith('.json')
          ? 'json'
          : 'text';
}
/** Registry derived from agent ownership, publication contract and existing report constants. */
export function artifactRegistry(slot: string): { slot: string; filename: string; role: DashboardArtifact['role'] }[] {
  const publication = publicationContractForClass('injection', true);
  const names = new Set([
    ...ALL_AGENTS.flatMap((agent) => getAgentGitPaths(agent)),
    ...publication.requiredOutputPaths,
    publication.manifestPath,
    REPORT_JSON_FILENAME,
    ASSEMBLED_REPORT_FILENAME,
    ASSEMBLED_REPORT_PDF_FILENAME,
    SARIF_FILENAME,
    REPORT_FINALIZATION_MANIFEST_FILENAME,
  ]);
  return [
    ...[...names].map((filename) => ({
      slot: `${slot}/${filename}`,
      filename,
      role: ([REPORT_JSON_FILENAME, ASSEMBLED_REPORT_FILENAME, SARIF_FILENAME].includes(filename)
        ? 'canonical'
        : filename === ASSEMBLED_REPORT_PDF_FILENAME
          ? 'derived'
          : 'intermediate') as DashboardArtifact['role'],
    })),
    { slot: FINAL_REPORT_MD_FILENAME, filename: FINAL_REPORT_MD_FILENAME, role: 'customer-copy' },
    { slot: FINAL_REPORT_PDF_FILENAME, filename: FINAL_REPORT_PDF_FILENAME, role: 'customer-copy' },
    { slot: SARIF_FILENAME, filename: SARIF_FILENAME, role: 'customer-copy' },
    { slot: '.astra/capella/report.md', filename: 'capella-report.md', role: 'intermediate' },
    { slot: '.astra/capella/capella.sarif', filename: 'capella.sarif', role: 'intermediate' },
  ];
}
function safeReportProjection(ws: WorkspaceRead, report: ReportRead): string | null {
  if (!report.raw || !report.sourceDigest) return null;
  const findings = Array.isArray(report.raw.findings)
    ? report.raw.findings.map((v, i) =>
        normalizeFinding(
          ws.name,
          'final_report',
          report.progress?.stage === 'finalized' ? 'report-finalized' : 'report-draft',
          v,
          reference('report-proof', { scope: 'artifact', sha256: report.sourceDigest, checkpoint: report.checkpoint }),
          `/findings/${i}`,
        ),
      )
    : [];
  return JSON.stringify(
    {
      publication: 'sanitized-dashboard-projection',
      lifecycle: report.progress?.stage ?? null,
      report_meta: {
        target: report.response.target.value,
        assessment_date: report.response.assessmentDate.value,
        scope: report.response.scope.value,
        executive_summary: report.response.executiveSummary.value,
        mode: report.response.mode.value,
        coverage: report.response.coverage.value,
      },
      findings,
    },
    null,
    2,
  );
}
function projectedMarkdown(projection: string): string {
  const data = record(JSON.parse(projection));
  const meta = record(data.report_meta);
  const findings = Array.isArray(data.findings) ? data.findings : [];
  // Plain-text safe Markdown: original raw HTML/code/prompts never copied.
  const text = (v: unknown) => (sanitizeText(v, 16000) ?? 'Unknown').replace(/[<>]/g, '');
  return (
    `# Astra Security Assessment\n\nSanitized dashboard projection. Lifecycle: ${text(data.lifecycle)}\n\nTarget: ${text(meta.target)}\n\n${text(meta.executive_summary)}\n\n` +
    findings
      .map((v) => {
        const f = record(v);
        return (
          `## ${text(f.findingId)} — ${text(f.title)}\n\nSeverity: ${text(f.severity)} | Confidence: ${text(f.confidence)} | Confirmation: ${text(f.confirmation)}\n\n` +
          (Array.isArray(f.evidence) ? f.evidence.map((e) => text(record(e).content)).join('\n\n') : '')
        );
      })
      .join('\n\n')
  );
}
function sanitizedSarif(bytes: string): string {
  const data = record(JSON.parse(bytes));
  if (data.version !== '2.1.0' || !Array.isArray(data.runs))
    throw new HttpError(403, 'PublicationBlocked', 'SARIF shape cannot be safely published.');
  return JSON.stringify(
    {
      version: '2.1.0',
      runs: data.runs.map((entry) => {
        const run = record(entry);
        const driver = record(record(run.tool).driver);
        return {
          tool: { driver: { name: sanitizeText(driver.name, 100) ?? 'Astra' } },
          results: Array.isArray(run.results)
            ? run.results.map((item) => {
                const r = record(item);
                return {
                  ruleId: sanitizeText(r.ruleId, 100) ?? 'unknown',
                  level: ['error', 'warning', 'note', 'none'].includes(String(r.level)) ? r.level : 'none',
                  message: { text: sanitizeText(record(r.message).text, 4000) ?? 'Unavailable' },
                  locations: Array.isArray(r.locations)
                    ? r.locations.flatMap((l) => {
                        const physical = record(record(l).physicalLocation);
                        const uri = record(physical.artifactLocation).uri;
                        if (typeof uri !== 'string' || !isNormalizedRepositoryPath(uri)) return [];
                        const region = record(physical.region);
                        return [
                          {
                            physicalLocation: {
                              artifactLocation: { uri },
                              ...(typeof region.startLine === 'number' && region.startLine > 0
                                ? { region: { startLine: region.startLine } }
                                : {}),
                            },
                          },
                        ];
                      })
                    : [],
                };
              })
            : [],
        };
      }),
    },
    null,
    2,
  );
}
export async function readArtifacts(ws: WorkspaceRead, report: ReportRead): Promise<ArtifactRead> {
  const artifacts: DashboardArtifact[] = [];
  const payloads: ArtifactRead['payloads'] = new Map();
  const slot = report.slot ?? '.astra/deliverables';
  const registry = artifactRegistry(slot);
  let head: string | null = null;
  let gitDir: string | null = null;
  try {
    gitDir = assertDeliverablesGit(ws.root, slot);
    head = (await readGit(gitDir, ['rev-parse', '--verify', 'HEAD'])).trim();
  } catch {
    /* unavailable Git */
  }
  const projection = safeReportProjection(ws, report);
  const canonical = new Map<string, Buffer>();
  if (gitDir && report.checkpoint && report.response.integrity === 'verified')
    for (const name of [REPORT_JSON_FILENAME, ASSEMBLED_REPORT_FILENAME, SARIF_FILENAME]) {
      const contents = await readGit(gitDir, ['show', `${report.checkpoint}:${name}`]).catch(() => null);
      if (contents !== null) canonical.set(name, Buffer.from(contents));
    }
  for (const entry of registry) {
    let bytes: Buffer | null = null;
    let verified = false;
    let verification: DashboardArtifact['verification'] = 'unverified';
    let status: DashboardArtifact['status'] = 'unknown';
    let checkpoint: string | null = null;
    try {
      const sourceName =
        entry.role === 'customer-copy'
          ? entry.filename === FINAL_REPORT_MD_FILENAME
            ? ASSEMBLED_REPORT_FILENAME
            : entry.filename === FINAL_REPORT_PDF_FILENAME
              ? ASSEMBLED_REPORT_PDF_FILENAME
              : SARIF_FILENAME
          : entry.filename;
      if (entry.role === 'canonical' && canonical.has(sourceName)) {
        bytes = canonical.get(sourceName) ?? null;
        verified = true;
        verification = 'manifest-sha256';
        checkpoint = report.checkpoint;
      } else {
        const file = optionalRead(ws.root, [entry.slot]);
        bytes = file?.bytes ?? null;
        if (
          bytes &&
          gitDir &&
          head &&
          entry.slot.startsWith(`${slot}/`) &&
          entry.filename !== ASSEMBLED_REPORT_PDF_FILENAME
        ) {
          const committed = await readGit(gitDir, ['show', `${head}:${entry.filename}`]).catch(() => null);
          if (committed !== null && digest(committed) === digest(bytes)) {
            verified = true;
            verification = 'git-checkpoint';
            checkpoint = head;
          }
        }
        if (entry.role === 'customer-copy' && bytes && canonical.has(sourceName)) {
          verified = digest(bytes) === digest(canonical.get(sourceName) as Buffer);
          verification = verified ? 'manifest-sha256' : 'invalid';
          checkpoint = report.checkpoint;
        }
        if (bytes && extension(entry.filename) === 'pdf' && report.progress?.stage === 'finalized') {
          const provenance = report.progress.pdf_provenance;
          verified =
            !!provenance &&
            !!report.sourceDigest &&
            provenance.canonical_report_sha256 === report.sourceDigest &&
            provenance.pdf_sha256 === digest(bytes);
          verification = verified ? 'pdf-provenance' : 'unverified';
        }
      }
      status = bytes
        ? 'available'
        : report.progress?.stage === 'finalized' && entry.role === 'canonical'
          ? 'missing'
          : 'not-yet-produced';
      if (
        sourceName === SARIF_FILENAME &&
        report.progress?.stage === 'finalized' &&
        report.progress.sarif_disposition !== 'committed'
      )
        status = 'not-applicable';
      if (report.response.integrity === 'invalid' && entry.role === 'canonical') {
        verification = 'invalid';
        verified = false;
        status = 'invalid';
      }
    } catch (error) {
      status = missing(error) ? 'missing' : 'unknown';
      verification = 'unavailable';
    }
    const hash = bytes ? digest(bytes) : null;
    const artifactId = digest(`${ws.name}|${entry.slot}|${hash ?? 'absent'}`);
    const provenance = [reference('artifacts', { scope: 'artifact', artifactId, sha256: hash, checkpoint })];
    let output: { bytes: Buffer; mime: string; filename: string } | null = null;
    // Integrity and publication are separate. Binary PDFs and intermediate raw narratives
    // have no secret-safe publication proof in Astra, so MVP offers sanitized report formats.
    if (bytes && verified && projection && report.response.integrity === 'verified') {
      if (entry.filename === REPORT_JSON_FILENAME)
        output = { bytes: Buffer.from(projection), mime: 'application/json', filename: 'report.sanitized.json' };
      else if ([ASSEMBLED_REPORT_FILENAME, FINAL_REPORT_MD_FILENAME].includes(entry.filename))
        output = {
          bytes: Buffer.from(projectedMarkdown(projection)),
          mime: 'text/markdown; charset=utf-8',
          filename: 'Security-Assessment-Report.sanitized.md',
        };
      else if (
        entry.filename === SARIF_FILENAME &&
        report.progress?.stage === 'finalized' &&
        report.progress.sarif_disposition === 'committed'
      ) {
        try {
          output = {
            bytes: Buffer.from(sanitizedSarif(bytes.toString('utf8'))),
            mime: 'application/sarif+json',
            filename: 'report.sanitized.sarif',
          };
        } catch {
          /* fail publication closed */
        }
      }
    }
    if (output) payloads.set(artifactId, output);
    artifacts.push({
      artifactId,
      filename: entry.filename,
      type: extension(entry.filename),
      role: entry.role,
      size: bytes?.length ?? null,
      createdAt: null,
      status,
      verified,
      verification,
      provenance,
      publicationStatus: output ? 'redacted' : bytes ? 'blocked' : 'unknown',
      download: {
        available: !!output,
        mode: output ? 'sanitized' : null,
        url: output ? `/api/scans/${encodeURIComponent(ws.name)}/artifacts/${artifactId}` : null,
        reasonCode: output ? null : bytes ? 'PublicationPolicyBlocked' : 'ArtifactUnavailable',
      },
    });
  }
  report.response.outputs = {
    json: artifacts.find((v) => v.filename === REPORT_JSON_FILENAME) ?? null,
    markdown: artifacts.find((v) => v.filename === ASSEMBLED_REPORT_FILENAME) ?? null,
    pdf: artifacts.find((v) => v.filename === ASSEMBLED_REPORT_PDF_FILENAME) ?? null,
    sarif: artifacts.find((v) => v.filename === SARIF_FILENAME && v.role === 'canonical') ?? null,
  };
  return { response: { artifacts, complete: artifacts.every((v) => v.status !== 'unknown') }, payloads };
}
export function artifactPayload(
  read: ArtifactRead,
  artifactId: string,
): { bytes: Buffer; mime: string; filename: string } {
  identifier(artifactId);
  const artifact = read.response.artifacts.find((v) => v.artifactId === artifactId);
  if (!artifact) throw new HttpError(404, 'ArtifactNotFound', 'Artifact does not exist in the registry.');
  if (['missing', 'not-yet-produced', 'not-applicable'].includes(artifact.status))
    throw new HttpError(404, 'ArtifactNotFound', 'Artifact is not available.');
  if (artifact.status === 'unknown' || artifact.verification === 'unavailable')
    throw new HttpError(503, 'ArtifactSourceUnavailable', 'Artifact source cannot be read safely.', true);
  const payload = read.payloads.get(artifactId);
  if (!payload)
    throw new HttpError(
      403,
      'PublicationBlocked',
      'Artifact publication is blocked. Use a verified sanitized report format.',
    );
  return payload;
}
