import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activityStatus, pipelineState, projectScan } from '../src/server/projection.js';
import { readReport } from '../src/server/readers/report-reader.js';
import { readWorkspace } from '../src/server/readers/workspace-reader.js';
import { execution, fixture, state } from './helpers.js';

const pending = {
  activityId: 'a-1',
  activityType: 'runInjectionVulnAgent',
  state: 'SCHEDULED' as const,
  attempt: 2,
  scheduledAt: Date.now(),
  startedAt: null,
  retryFailure: true,
};
test('scheduled activity and retry failure stay pending; pipelines resolves actual started activity only', async () => {
  const f = fixture();
  try {
    const ws = readWorkspace(f.root, f.name);
    const e = execution({ pending: [pending] });
    const report = await readReport(ws, state());
    const data = projectScan(
      ws,
      { execution: e, health: 'fresh', observedAt: new Date().toISOString(), reasonCode: null },
      report,
    );
    assert.equal(data.agents.agents.find((v) => v.name === 'injection-vuln')?.status.value, 'pending');
    assert.equal(data.summary.currentAgent.value, null);
    assert.equal(data.summary.businessStatus.value, 'running');
    const started = { ...pending, state: 'STARTED' as const, startedAt: Date.now() };
    assert.equal(activityStatus(started), 'running');
    const active = projectScan(
      ws,
      {
        execution: { ...e, pending: [started] },
        health: 'fresh',
        observedAt: new Date().toISOString(),
        reasonCode: null,
      },
      report,
    );
    assert.equal(active.summary.currentAgent.value, 'injection-vuln');
  } finally {
    f.close();
  }
});
test('missing metrics is unknown; only explicit skipped counts as processed', async () => {
  const f = fixture();
  try {
    const ws = readWorkspace(f.root, f.name);
    const s = state({ skippedAgents: ['injection-exploit'] });
    const report = await readReport(ws, s);
    const data = projectScan(
      ws,
      {
        execution: execution({ progress: s }),
        health: 'fresh',
        observedAt: new Date().toISOString(),
        reasonCode: null,
      },
      report,
    );
    assert.equal(data.agents.agents.find((v) => v.name === 'injection-vuln')?.status.value, 'unknown');
    assert.equal(data.agents.agents.find((v) => v.name === 'injection-exploit')?.status.value, 'skipped');
    assert.equal(data.workflow.processedAgents.value, 3);
    assert.equal(data.workflow.expectedAgents.value, 5);
    assert.equal('percentage' in data.workflow, false);
  } finally {
    f.close();
  }
});
test('Temporal unavailable does not invent execution or business failure', async () => {
  const f = fixture();
  try {
    const ws = readWorkspace(f.root, f.name);
    const report = await readReport(ws, null);
    const data = projectScan(
      ws,
      { execution: null, health: 'unavailable', observedAt: null, reasonCode: 'TemporalUnavailable' },
      report,
    );
    assert.equal(data.summary.executionStatus.value, null);
    assert.equal(data.summary.businessStatus.value, null);
    assert.equal(data.workflow.processedAgents.value, null);
    assert.ok(data.agents.agents.every((v) => v.status.value === 'unknown'));
  } finally {
    f.close();
  }
});
test('stale observations retain stale provenance and do not become fresh state', async () => {
  const f = fixture();
  try {
    const ws = readWorkspace(f.root, f.name);
    const s = state();
    const data = projectScan(
      ws,
      {
        execution: execution(),
        health: 'stale',
        observedAt: '2026-01-01T00:00:00Z',
        reasonCode: 'TemporalUnavailable',
      },
      await readReport(ws, s),
    );
    assert.equal(data.summary.executionStatus.health, 'stale');
    assert.equal(data.summary.businessStatus.health, 'stale');
    assert.equal(data.summary.stale, true);
  } finally {
    f.close();
  }
});
test('reject inconsistent domain progress rather than creating a second state machine', () => {
  assert.equal(pipelineState({ ...state(), expectedAgents: ['invented-agent'] }), null);
  assert.equal(pipelineState({ ...state(), skippedAgents: ['pre-recon'] }), null);
  assert.equal(pipelineState({ ...state(), partialReasons: {} }), null);
});

test('report lifecycle from a stale Temporal observation keeps its execution provenance', async () => {
  const f = fixture();
  try {
    const ws = readWorkspace(f.root, f.name);
    const s = state({ reportProgress: { stage: 'pending', renumber_failed_classes: [], partial_reasons: [] } });
    const temporal = {
      execution: execution({ progress: s }),
      health: 'stale' as const,
      observedAt: '2026-01-01T00:00:00Z',
      reasonCode: 'TemporalUnavailable',
    };
    const report = await readReport(ws, s, temporal);
    assert.equal(report.response.lifecycle.health, 'stale');
    assert.equal(report.response.lifecycle.references[0]?.source, 'temporal-progress');
    assert.equal(report.response.lifecycle.references[0]?.runId, 'run-1');
  } finally {
    f.close();
  }
});
