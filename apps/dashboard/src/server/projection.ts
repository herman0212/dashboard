import type { AgenticSastState, PipelineState } from '@astra/worker/dashboard-contracts';
import { AGENT_PHASE_MAP, AGENTS, CAPELLA_PROGRESS_STAGES, isDurableScanState } from '@astra/worker/dashboard-read';
import { ACTIVITY_TO_PROGRESS, type DashboardPendingActivity, PIPELINE } from '@keygraph/astra/dashboard-read';
import type { AgentStatus, DashboardIssue, RunStatus, ScanDetail, SourceHealth, WorkflowStage } from '../contracts.js';
import type { ReportRead } from './readers/report-reader.js';
import { fact, reference } from './readers/report-reader.js';
import type { TemporalRead } from './readers/temporal-reader.js';
import type { WorkspaceRead } from './readers/workspace-reader.js';
import { iso, number, record, sanitizeText } from './security.js';

const statuses = ['running', 'completed', 'failed', 'cancelled', 'partial'];
/** Validate the domain scope with Astra's own durable-state validator before projecting. */
export function pipelineState(value: unknown): PipelineState | null {
  const v = record(value);
  if (
    !statuses.includes(String(v.status)) ||
    !Array.isArray(v.completedAgents) ||
    !Array.isArray(v.skippedAgents) ||
    !Array.isArray(v.expectedAgents) ||
    !Array.isArray(v.participatingClasses)
  )
    return null;
  if (![...v.completedAgents, ...v.skippedAgents, ...v.expectedAgents].every((name) => typeof name === 'string'))
    return null;
  if (
    !isDurableScanState({
      schema_version: 1,
      exploit: v.expectedAgents.includes('injection-exploit'),
      expected_agents: v.expectedAgents,
      participating_classes: v.participatingClasses,
    })
  )
    return null;
  if (
    !v.completedAgents.every((name) => Array.isArray(v.expectedAgents) && v.expectedAgents.includes(name)) ||
    !v.skippedAgents.every((name) => Array.isArray(v.expectedAgents) && v.expectedAgents.includes(name)) ||
    v.completedAgents.some((name) => Array.isArray(v.skippedAgents) && v.skippedAgents.includes(name))
  )
    return null;
  if (number(v.startTime) === null) return null;
  if (
    v.partialReasons !== undefined &&
    (!Array.isArray(v.partialReasons) ||
      !v.partialReasons.every(
        (reason) => typeof record(reason).code === 'string' && typeof record(reason).message === 'string',
      ))
  )
    return null;
  if (v.nonFatalFailures !== undefined && !Array.isArray(v.nonFatalFailures)) return null;
  return v as unknown as PipelineState;
}
export function activityStatus(activity: DashboardPendingActivity): RunStatus {
  return activity.state === 'STARTED' ? 'running' : activity.state === 'SCHEDULED' ? 'pending' : 'unknown';
}
function safeCapella(value: unknown): AgenticSastState | null {
  const v = record(value);
  if (v.status === 'disabled') return { status: 'disabled' };
  if (v.status === 'running' && number(v.startedAt) !== null)
    return { status: 'running', startedAt: v.startedAt as number };
  if (
    v.status === 'succeeded' &&
    number(v.findingCount) !== null &&
    typeof v.sarifSha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(v.sarifSha256) &&
    ['complete', 'reduced'].includes(String(v.coverage)) &&
    number(v.durationMs) !== null
  )
    return {
      status: 'succeeded',
      findingCount: v.findingCount as number,
      sarifSha256: v.sarifSha256,
      coverage: v.coverage as 'complete' | 'reduced',
      warnings: Array.isArray(v.warnings) ? v.warnings.map((s) => sanitizeText(s) ?? 'Warning') : [],
      durationMs: v.durationMs as number,
    };
  if (
    v.status === 'failed' &&
    typeof v.failedStage === 'string' &&
    [...CAPELLA_PROGRESS_STAGES, 'export', 'workflow'].includes(v.failedStage) &&
    number(v.durationMs) !== null
  )
    return {
      status: 'failed',
      failedStage: v.failedStage as Extract<AgenticSastState, { status: 'failed' }>['failedStage'],
      failedStageLabel: sanitizeText(v.failedStageLabel, 100) ?? 'Unknown stage',
      error: 'Static analysis could not finish.',
      completedStages: Array.isArray(v.completedStages)
        ? v.completedStages.filter((s) => CAPELLA_PROGRESS_STAGES.includes(s))
        : [],
      warnings: [],
      durationMs: v.durationMs as number,
    };
  return null;
}
export function projectScan(ws: WorkspaceRead, temporal: TemporalRead, report: ReportRead): ScanDetail {
  const now = new Date().toISOString();
  const execution = temporal.execution;
  const state = pipelineState(execution?.progress);
  const progressRef = reference(execution?.progressSource === 'result' ? 'temporal-result' : 'temporal-progress', {
    scope: 'execution',
    workflowId: ws.workflowId,
    runId: execution?.runId ?? null,
  });
  const describeRef = reference('temporal-describe', {
    scope: 'execution',
    workflowId: ws.workflowId,
    runId: execution?.runId ?? null,
  });
  const sessionRef = reference('session', { sha256: ws.sessionDigest });
  const progressHealth = state ? temporal.health : 'unavailable';
  const stateFact = <T>(v: T | null) => fact(v, [progressRef], temporal.observedAt, progressHealth);
  const describeFact = <T>(v: T | null) => fact(v, [describeRef], temporal.observedAt, temporal.health);
  const expected = state?.expectedAgents ?? (ws.durable ? [...ws.durable.expected_agents] : null);
  const expectedRef = state ? [progressRef] : [sessionRef];
  const pending = execution?.pending ?? [];
  const elapsedUntil = temporal.health === 'stale' ? Date.parse(temporal.observedAt ?? '') : Date.now();
  const agents: AgentStatus[] = PIPELINE.flatMap((phase) =>
    phase.agents.map((agent) => ({ ...agent, phase: phase.key })),
  ).map((spec) => {
    const activity = pending.find((v) => ACTIVITY_TO_PROGRESS[v.activityType]?.key === spec.name);
    const metrics = record(state?.agentMetrics?.[spec.name]);
    let status: RunStatus = activity ? activityStatus(activity) : 'unknown';
    // Positive completion/skip/terminal evidence, never absence of metrics.
    if (state?.completedAgents.includes(spec.name)) status = 'completed';
    else if (state?.skippedAgents.includes(spec.name) || metrics.skipped === true) status = 'skipped';
    else if (state?.failedAgent === spec.name && state.status === 'failed') status = 'failed';
    else if (spec.name === 'validate-authentication' && number(metrics.durationMs) !== null && !activity)
      status = 'completed';
    const conflicting = !!activity && (status === 'completed' || status === 'skipped' || status === 'failed');
    if (conflicting) status = 'unknown';
    const metricValues = {
      durationMs: number(metrics.durationMs),
      costUsd: number(metrics.costUsd),
      numTurns: number(metrics.numTurns),
      inputTokens: number(metrics.inputTokens),
      outputTokens: number(metrics.outputTokens),
      cacheReadTokens: number(metrics.cacheReadTokens),
      cacheWriteTokens: number(metrics.cacheWriteTokens),
    };
    const started = activity?.state === 'STARTED' ? activity.startedAt : null;
    return {
      name: spec.name,
      phase: spec.phase,
      status: activity ? describeFact(status) : stateFact(status),
      activityId: describeFact(activity?.activityId ?? null),
      activityState: describeFact(activity?.state ?? null),
      attempt: describeFact(activity?.attempt ?? null),
      scheduledAt: describeFact(iso(activity?.scheduledAt)),
      startedAt: describeFact(iso(started)),
      completedAt: fact<string>(null),
      elapsedMs: describeFact(
        started != null && Number.isFinite(elapsedUntil) ? Math.max(0, elapsedUntil - started) : null,
      ),
      metrics: stateFact(
        number(metrics.durationMs) !== null
          ? {
              scope: 'execution' as const,
              values: { ...metricValues, durationMs: metricValues.durationMs as number },
              complete: metricValues.costUsd !== null && metricValues.numTurns !== null,
            }
          : null,
      ),
      latestKnownActivity: fact<never>(null),
    };
  });
  const stages: WorkflowStage[] = agents.map((agent) => ({
    id: agent.name,
    label:
      agent.name === 'validate-authentication'
        ? 'Setup / Authentication'
        : agent.name === 'injection-vuln'
          ? 'Injection Analysis'
          : agent.name === 'injection-exploit'
            ? 'Exploitation'
            : (AGENTS[agent.name as keyof typeof AGENTS]?.displayName ?? agent.name),
    kind: 'agent',
    lane: agent.name === 'report' ? 'reporting' : 'pentest',
    parentId: null,
    participation: fact(
      expected && agent.name !== 'validate-authentication'
        ? expected.includes(agent.name)
          ? 'enabled'
          : 'disabled'
        : null,
      expectedRef,
    ),
    status: agent.status,
    startedAt: agent.startedAt,
    completedAt: agent.completedAt,
    durationMs: stateFact(agent.metrics.value?.values.durationMs ?? null),
    agentNames: [agent.name],
    dependsOn: agent.name in AGENTS ? [...AGENTS[agent.name as keyof typeof AGENTS].prerequisites] : [],
  }));
  const operational = record(state?.operationalStages);
  for (const [id, raw] of Object.entries(operational)) {
    if (!/^[a-z0-9:-]{1,120}$/.test(id)) continue;
    const v = record(raw);
    const status = ['pending', 'running', 'completed', 'failed', 'skipped'].includes(String(v.status))
      ? (v.status as RunStatus)
      : 'unknown';
    stages.push({
      id,
      label: sanitizeText(v.label, 150) ?? id,
      kind: 'operation',
      lane: id.startsWith('agentic-sast') ? 'capella' : id.startsWith('report:') ? 'reporting' : 'pentest',
      parentId: null,
      participation: stateFact('enabled'),
      status: stateFact(status),
      startedAt: stateFact(iso(v.startedAt)),
      completedAt: stateFact(
        status === 'completed' && number(v.startedAt) !== null && number(v.durationMs) !== null
          ? iso((v.startedAt as number) + (v.durationMs as number))
          : null,
      ),
      durationMs: stateFact(number(v.durationMs)),
      agentNames: [],
      dependsOn: [],
    });
  }
  for (const p of pending) {
    const mapping = ACTIVITY_TO_PROGRESS[p.activityType];
    if (mapping?.kind === 'agent') continue;
    const id = mapping?.key ?? 'unmapped-activity';
    const existing = stages.find(
      (s) => s.id === id || (mapping?.parentKey && s.id.startsWith(`${mapping.parentKey}:`)),
    );
    if (existing && (existing.status.value === 'completed' || existing.status.value === 'failed')) {
      existing.status = describeFact('unknown');
      continue;
    }
    if (existing) {
      continue;
    }
    stages.push({
      id,
      label: mapping?.label ?? 'Unmapped activity',
      kind: 'operation',
      lane: id.startsWith('agentic-sast') ? 'capella' : id.startsWith('report:') ? 'reporting' : 'pentest',
      parentId: null,
      participation: describeFact('enabled'),
      status: describeFact(activityStatus(p)),
      startedAt: describeFact(p.state === 'STARTED' ? iso(p.startedAt) : null),
      completedAt: fact<never>(null),
      durationMs: fact<never>(null),
      agentNames: [],
      dependsOn: [],
    });
  }
  if (!stages.some((s) => s.id.startsWith('reconciliation')))
    stages.push({
      id: 'reconciliation',
      label: 'Reconciliation',
      kind: 'operation',
      lane: 'pentest',
      parentId: null,
      participation: fact<never>(null),
      status: fact('unknown', [], null, 'unavailable'),
      startedAt: fact<never>(null),
      completedAt: fact<never>(null),
      durationMs: fact<never>(null),
      agentNames: [],
      dependsOn: ['injection-vuln'],
    });
  const issues: DashboardIssue[] = [];
  const issue = (kind: DashboardIssue['kind'], code: string, message: string) =>
    issues.push({ kind, code, message, references: [progressRef] });
  if (temporal.reasonCode)
    issue(
      'source-error',
      temporal.reasonCode,
      temporal.reasonCode === 'TemporalUnavailable'
        ? 'Temporal cannot be reached. Last observations may be stale.'
        : 'Temporal execution could not be found.',
    );
  if (execution?.terminalFailure || state?.status === 'failed')
    issue('execution-error', 'ExecutionFailed', 'This execution recorded a terminal failure.');
  if (execution?.progressUnavailable)
    issue('source-error', 'ProgressUnavailable', 'Workflow progress is unavailable; missing values are unknown.');
  if (ws.startupError)
    issue(
      'source-error',
      'StartupRecordPresent',
      'A startup diagnostic exists in this workspace. It is not correlated to the current execution.',
    );
  if (ws.sessionUnavailable)
    issue('source-error', 'SessionUnavailable', 'Some workspace identity/state records could not be read safely.');
  if (ws.externalOutputConfigured)
    issue(
      'output-warning',
      'ExternalOutputNotEnumerated',
      'Launch configuration includes an output destination outside the dashboard artifact registry. Canonical workspace reports remain available; external copies are not read.',
    );
  for (const reason of state?.partialReasons ?? [])
    if (/^[a-z_]+$/.test(reason.code))
      issue('coverage-limitation', reason.code, sanitizeText(reason.message) ?? 'Coverage is reduced.');
  for (const failure of state?.nonFatalFailures ?? []) {
    const v = record(failure);
    issue(
      'output-warning',
      'NonFatalFailure',
      `Output operation ${sanitizeText(v.phase, 100) ?? 'unknown'} recorded a non-fatal failure.`,
    );
  }
  if (report.response.integrity === 'invalid')
    issue(
      'integrity-error',
      'ReportIntegrityInvalid',
      'Recorded report lifecycle cannot be verified against its committed artifacts.',
    );
  if (pending.some((v) => v.retryFailure))
    issue(
      'source-error',
      'ActivityRetry',
      'An activity has a prior attempt failure. Its current attempt is pending/running; terminal failure is not established.',
    );
  if (pending.some((v) => !ACTIVITY_TO_PROGRESS[v.activityType]))
    issue('source-error', 'ActivityMirrorIncomplete', 'An activity is unknown to this dashboard version.');
  const sourceHealth: SourceHealth[] = [
    {
      source: 'workspace-identity',
      health: ws.identityStatus === 'confirmed' ? 'fresh' : 'partial',
      checkedAt: now,
      lastSuccessAt: ws.identityStatus === 'confirmed' ? now : null,
      reasonCode: ws.identityStatus === 'confirmed' ? null : 'IdentityUnconfirmed',
    },
    {
      source: 'session',
      health: ws.session ? 'fresh' : 'unavailable',
      checkedAt: now,
      lastSuccessAt: ws.session ? now : null,
      reasonCode: ws.session ? null : 'SessionUnavailable',
    },
    {
      source: 'temporal-describe',
      health: temporal.health,
      checkedAt: now,
      lastSuccessAt: temporal.observedAt,
      reasonCode: temporal.reasonCode,
    },
    {
      source: execution?.progressSource === 'result' ? 'temporal-result' : 'temporal-progress',
      health: progressHealth,
      checkedAt: now,
      lastSuccessAt: state ? temporal.observedAt : null,
      reasonCode: state ? null : 'ProgressUnavailable',
    },
    {
      source: 'report-proof',
      health: report.response.integrity === 'verified' ? 'fresh' : report.progress ? 'partial' : 'unavailable',
      checkedAt: now,
      lastSuccessAt: report.response.integrity === 'verified' ? now : null,
      reasonCode: report.response.integrity === 'verified' ? null : 'ReportProofUnavailable',
    },
  ];
  const active = pending
    .filter((v) => v.state === 'STARTED')
    .flatMap((v) => {
      const m = ACTIVITY_TO_PROGRESS[v.activityType];
      return m?.kind === 'agent' ? [m.key] : [];
    });
  const businessFromSession = record(record(ws.session?.metrics).runs)[ws.workflowId ?? ''];
  const terminalBusiness = record(businessFromSession);
  const business =
    state?.status ??
    (['completed', 'failed', 'cancelled', 'partial'].includes(String(terminalBusiness.status))
      ? (terminalBusiness.status as PipelineState['status'])
      : null);
  const businessFact = state
    ? stateFact(business)
    : fact(business, [
        reference('session', {
          scope: 'execution',
          workflowId: ws.workflowId,
          jsonPointer: '/metrics/runs',
          sha256: ws.sessionDigest,
        }),
      ]);
  const processed =
    state && expected
      ? new Set([...state.completedAgents, ...state.skippedAgents].filter((v) => expected.includes(v))).size
      : null;
  return {
    summary: {
      workspace: ws.name,
      identityStatus: ws.identityStatus,
      workflowId: fact(ws.workflowId, [sessionRef]),
      runId: describeFact(execution?.runId ?? null),
      target: fact(ws.target, [sessionRef]),
      executionStatus: describeFact(execution?.status ?? null),
      businessStatus: businessFact,
      currentPhase: stateFact(sanitizeText(state?.currentPhase, 120)),
      currentAgent: describeFact(active.length === 1 ? (active[0] ?? null) : null),
      activeAgentNames: describeFact(execution ? active : null),
      elapsedMs: describeFact(
        execution?.startedAt != null && Number.isFinite(elapsedUntil)
          ? Math.max(0, (execution.closedAt ?? elapsedUntil) - execution.startedAt)
          : null,
      ),
      lastUpdated: now,
      sourceHealth,
      stale: temporal.health === 'stale',
      reportLifecycle: report.response.lifecycle,
      issues,
    },
    workflow: {
      workspace: ws.name,
      workflowId: ws.workflowId,
      runId: execution?.runId ?? null,
      stages,
      currentStageIds: stages.filter((s) => s.status.value === 'running').map((s) => s.id),
      completed: state?.completedAgents ?? [],
      skipped: state?.skippedAgents ?? [],
      failed: state?.failedAgent ? [state.failedAgent] : [],
      expectedAgentNames: fact(expected, expectedRef),
      expectedAgents: fact(expected?.length ?? null, expectedRef),
      processedAgents: stateFact(processed),
      countSemantics: 'resolved-pentest-agents',
      capella: stateFact(safeCapella(state?.agenticSast)),
      reconciliation: stages.filter((s) => s.id.startsWith('reconciliation')),
      reporting: { lifecycle: report.response.lifecycle, integrity: report.response.integrity },
    },
    agents: { agents, complete: !!state && !pending.some((v) => !ACTIVITY_TO_PROGRESS[v.activityType]) },
  };
}
export const agentPhase = (name: string): string | null =>
  AGENT_PHASE_MAP[name as keyof typeof AGENT_PHASE_MAP] ?? null;
