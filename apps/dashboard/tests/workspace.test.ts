import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { projectScan } from '../src/server/projection.js';
import { readReport } from '../src/server/readers/report-reader.js';
import { readWorkspace } from '../src/server/readers/workspace-reader.js';
import { fixture } from './helpers.js';

test('pending identities reuse the CLI validator and remain registration evidence only', () => {
  const f = fixture();
  try {
    f.session.session.originalWorkflowId = '';
    f.save();
    const dir = path.join(f.workspace, '.astra/pending-workflows');
    fs.mkdirSync(dir);
    const filename = path.join(dir, 'launch-astra-deadbeef.json');
    const candidate = {
      schema_version: 1,
      workflow_id: `${f.name}_resume_123`,
      task_queue: 'astra-deadbeef',
      created_at: '2026-10-08T00:00:00.000Z',
    };
    fs.writeFileSync(filename, JSON.stringify(candidate));
    const ws = readWorkspace(f.root, f.name);
    assert.equal(ws.workflowId, candidate.workflow_id);
    assert.equal(ws.identityStatus, 'pending-registration');
    fs.writeFileSync(filename, JSON.stringify({ ...candidate, workflow_id: 'arbitrary-identity', secret: 'private' }));
    assert.equal(readWorkspace(f.root, f.name).workflowId, null);
  } finally {
    f.close();
  }
});

test('offline business outcome requires terminal metrics for the exact workflow identity', async () => {
  const f = fixture();
  try {
    Object.assign(f.session.metrics.runs, { 'previous-workflow': { status: 'completed' } });
    Object.assign(f.session.session, { status: 'completed' });
    f.save();
    const temporal = {
      execution: null,
      health: 'unavailable' as const,
      observedAt: null,
      reasonCode: 'TemporalUnavailable',
    };
    const ws = readWorkspace(f.root, f.name);
    assert.equal(projectScan(ws, temporal, await readReport(ws, null)).summary.businessStatus.value, null);
    Object.assign(f.session.metrics.runs, { 'test-workflow': { status: 'partial' } });
    f.save();
    const current = readWorkspace(f.root, f.name);
    const scan = projectScan(current, temporal, await readReport(current, null));
    assert.equal(scan.summary.businessStatus.value, 'partial');
    assert.equal(scan.summary.executionStatus.value, null);
    assert.equal(scan.summary.businessStatus.references[0]?.source, 'session');
  } finally {
    f.close();
  }
});

test('launch output destinations are observed without exposing or following their filesystem paths', () => {
  const f = fixture();
  try {
    fs.writeFileSync(
      path.join(f.workspace, '.astra/launch.json'),
      JSON.stringify({ schema_version: 1, customer_output_path: 'C:\\private-output' }),
    );
    const ws = readWorkspace(f.root, f.name);
    assert.equal(ws.externalOutputConfigured, true);
    assert.equal(JSON.stringify(ws.session).includes('private-output'), false);
  } finally {
    f.close();
  }
});
