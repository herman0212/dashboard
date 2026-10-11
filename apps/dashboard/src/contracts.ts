import type { AgenticSastState, AgentMetrics, PipelineState, ReportProgress } from '@astra/worker/dashboard-contracts';
export interface ControlCapabilities {
  csrfToken: string;
  available: boolean;
  stopAvailable?: boolean;
  reason: string | null;
  repositoryRoots: string[];
  workspaceRoot: string;
  runtime?: string;
  issues?: { code: string; message: string }[];
}
export interface ControlOperation {
  id: string;
  kind: 'start' | 'stop';
  workspace: string;
  requestedAt: string;
  updatedAt: string;
  processState: 'starting' | 'running' | 'exited' | 'failed' | 'unknown';
  pid: number | null;
  exitCode: number | null;
  signal: string | null;
  error: { code: string; message: string } | null;
}
export type DataHealth = 'fresh' | 'stale' | 'partial' | 'unavailable';
export type SourceKey =
  | 'workspace-index'
  | 'workspace-identity'
  | 'session'
  | 'temporal-describe'
  | 'temporal-progress'
  | 'temporal-result'
  | 'findings'
  | 'logs'
  | 'artifacts'
  | 'report-proof';
export interface DataReference {
  source: SourceKey;
  scope: 'execution' | 'workspace' | 'artifact';
  workflowId: string | null;
  runId: string | null;
  artifactId: string | null;
  checkpoint: string | null;
  sha256: string | null;
  jsonPointer: string | null;
  lineRange: [number, number] | null;
}
export interface Fact<T> {
  value: T | null;
  health: DataHealth;
  observedAt: string | null;
  references: DataReference[];
  reasonCode: string | null;
}
export interface SourceHealth {
  source: SourceKey;
  health: DataHealth;
  checkedAt: string;
  lastSuccessAt: string | null;
  reasonCode: string | null;
}
export interface DashboardIssue {
  kind: 'execution-error' | 'coverage-limitation' | 'output-warning' | 'source-error' | 'integrity-error';
  code: string;
  message: string;
  references: DataReference[];
}
export interface ResponseMeta {
  schemaVersion: '1';
  snapshotId: string;
  generatedAt: string;
  health: DataHealth;
  sources: SourceHealth[];
  issues: DashboardIssue[];
}
export interface ApiResponse<T> {
  data: T | null;
  meta: ResponseMeta;
}
export interface ApiErrorResponse {
  error: { code: string; message: string; retryable: boolean };
  meta: ResponseMeta;
}
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  previousCursor: string | null;
  total: number | null;
  complete: boolean;
}
export interface ScanSummary {
  workspace: string;
  identityStatus: 'confirmed' | 'pending-registration' | 'ambiguous' | 'unavailable';
  workflowId: Fact<string>;
  runId: Fact<string>;
  target: Fact<string>;
  executionStatus: Fact<string>;
  businessStatus: Fact<PipelineState['status']>;
  currentPhase: Fact<string>;
  currentAgent: Fact<string>;
  activeAgentNames: Fact<string[]>;
  elapsedMs: Fact<number>;
  lastUpdated: string;
  sourceHealth: SourceHealth[];
  stale: boolean;
  reportLifecycle: Fact<ReportProgress['stage']>;
  issues: DashboardIssue[];
}
export type RunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'unknown';
export interface WorkflowStage {
  id: string;
  label: string;
  kind: 'agent' | 'operation' | 'group';
  lane: 'pentest' | 'capella' | 'reporting';
  parentId: string | null;
  participation: Fact<'enabled' | 'disabled'>;
  status: Fact<RunStatus>;
  startedAt: Fact<string>;
  completedAt: Fact<string>;
  durationMs: Fact<number>;
  agentNames: string[];
  dependsOn: string[];
}
export interface WorkflowProgress {
  workspace: string;
  workflowId: string | null;
  runId: string | null;
  stages: WorkflowStage[];
  currentStageIds: string[];
  completed: string[];
  skipped: string[];
  failed: string[];
  expectedAgentNames: Fact<string[]>;
  expectedAgents: Fact<number>;
  processedAgents: Fact<number>;
  countSemantics: 'resolved-pentest-agents';
  capella: Fact<AgenticSastState>;
  reconciliation: WorkflowStage[];
  reporting: ReportStatus;
}
export interface AgentMetricsView {
  scope: 'attempt' | 'execution' | 'workspace';
  values: Partial<AgentMetrics>;
  complete: boolean;
}
export interface KnownActivity {
  eventId: string;
  timestamp: string | null;
  kind: 'tool' | 'delegation' | 'lifecycle';
  message: string;
  reference: DataReference;
}
export interface AgentStatus {
  name: string;
  phase: string | null;
  status: Fact<RunStatus>;
  activityId: Fact<string>;
  activityState: Fact<string>;
  attempt: Fact<number>;
  scheduledAt: Fact<string>;
  startedAt: Fact<string>;
  completedAt: Fact<string>;
  elapsedMs: Fact<number>;
  metrics: Fact<AgentMetricsView>;
  latestKnownActivity: Fact<KnownActivity>;
}
export type FindingSource = 'analysis_queue' | 'exploitation_result' | 'reconciliation' | 'final_report' | 'capella';
export type FindingStage =
  | 'analysis'
  | 'reconciliation'
  | 'exploitation'
  | 'report-draft'
  | 'report-finalized'
  | 'sast';
export interface FindingLocation {
  kind: 'code' | 'http' | 'text';
  file: string | null;
  startLine: number | null;
  endLine: number | null;
  role: string | null;
  symbol: string | null;
  method: string | null;
  url: string | null;
  display: string;
}
export interface FindingEvidence {
  kind: 'prose' | 'code' | 'reference';
  label: string;
  content: string;
  language: string | null;
  redacted: boolean;
  reference: DataReference;
}
export interface DashboardFinding {
  dashboardId: string;
  identityScope: 'artifact-version';
  recordVersion: string;
  source: FindingSource;
  stage: FindingStage;
  sourceStage: string | null;
  findingId: string | null;
  title: string | null;
  vulnerabilityType: string | null;
  category: string | null;
  severity: 'critical' | 'high' | 'medium' | 'low' | null;
  confidence: 'high' | 'medium' | 'low' | null;
  outcome: { namespace: FindingSource; value: string } | null;
  confirmation: 'unknown' | 'static' | 'exploited';
  locations: FindingLocation[];
  evidence: FindingEvidence[];
  provenance: DataReference[];
  relations: { dashboardId: string; kind: 'derived_from' | 'merged_from' | 'duplicate_of'; proof: DataReference }[];
}
export interface FindingsResponse {
  page: Page<DashboardFinding>;
  selectedSources: FindingSource[];
  coverage: { source: FindingSource; health: DataHealth; complete: boolean; count: number | null }[];
}
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'unknown';
export interface LogEntry {
  id: string;
  timestamp: string | null;
  source: 'workflow-log' | 'agent-log';
  agent: string | null;
  phase: string | null;
  attempt: number | null;
  parseStatus: 'recognized' | 'unstructured' | 'redacted';
  event: string | null;
  message: string;
  level: LogLevel;
  sanitizedRaw: string | null;
  reference: DataReference;
}
export interface LogsResponse {
  entries: LogEntry[];
  nextCursor: string;
  olderCursor: string | null;
  hasMore: boolean;
  omittedCount: number;
  scope: 'workspace';
}
export type ArtifactStatus = 'available' | 'not-yet-produced' | 'not-applicable' | 'missing' | 'invalid' | 'unknown';
export interface DashboardArtifact {
  artifactId: string;
  filename: string;
  type: 'json' | 'markdown' | 'pdf' | 'sarif' | 'text';
  role: 'intermediate' | 'canonical' | 'derived' | 'customer-copy';
  size: number | null;
  createdAt: string | null;
  status: ArtifactStatus;
  verified: boolean;
  verification: 'git-checkpoint' | 'manifest-sha256' | 'pdf-provenance' | 'unverified' | 'invalid' | 'unavailable';
  provenance: DataReference[];
  publicationStatus: 'allowed' | 'redacted' | 'blocked' | 'unknown';
  download: {
    available: boolean;
    mode: 'sanitized' | 'original' | null;
    url: string | null;
    reasonCode: string | null;
  };
}
export interface DeliverablesResponse {
  artifacts: DashboardArtifact[];
  complete: boolean;
}
export interface ReportStatus {
  lifecycle: Fact<ReportProgress['stage']>;
  integrity: 'verified' | 'unverified' | 'invalid' | 'unavailable';
}
export interface ReportResponse extends ReportStatus {
  mode: Fact<'exploits' | 'findings'>;
  target: Fact<string>;
  assessmentDate: Fact<string>;
  scope: Fact<string>;
  executiveSummary: Fact<string>;
  coverage: Fact<{ status: string; limitations: { code: string; message: string }[] }>;
  modelCheckpoint: Fact<string>;
  canonicalCheckpoint: Fact<string>;
  finalCheckpoint: Fact<string>;
  outputs: {
    json: DashboardArtifact | null;
    markdown: DashboardArtifact | null;
    pdf: DashboardArtifact | null;
    sarif: DashboardArtifact | null;
  };
}
export interface ScanDetail {
  summary: ScanSummary;
  workflow: WorkflowProgress;
  agents: { agents: AgentStatus[]; complete: boolean };
}
