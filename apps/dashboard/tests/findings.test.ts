import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { exploitationQueuePath, reconciliationManifestPath } from '@astra/worker/dashboard-read';
import {
  type FindingCollection,
  normalizeFinding,
  projectFindings,
  readFindingCollections,
} from '../src/server/readers/finding-reader.js';
import { readReport, reference } from '../src/server/readers/report-reader.js';
import { readWorkspace } from '../src/server/readers/workspace-reader.js';
import { fixture, git } from './helpers.js';

const ref = reference('findings', { scope: 'artifact', sha256: 'a'.repeat(64), artifactId: 'artifact-a' });
test('corrupt committed manifest cannot be mistaken for an unpublished analysis queue', async () => {
  const f = fixture();
  try {
    const dir = path.join(f.workspace, '.astra/deliverables');
    git(dir, 'init');
    fs.writeFileSync(
      path.join(dir, exploitationQueuePath('injection')),
      JSON.stringify({ vulnerabilities: [{ ID: 'INJ-01' }] }),
    );
    fs.writeFileSync(path.join(dir, reconciliationManifestPath('injection')), '{corrupted');
    git(dir, 'add', '.');
    git(dir, 'commit', '-m', 'Corrupt publication fixture');
    const ws = readWorkspace(f.root, f.name);
    const collections = await readFindingCollections(ws, await readReport(ws, null));
    assert.equal(collections.find((source) => source.source === 'analysis_queue')?.complete, false);
    assert.equal(collections.find((source) => source.source === 'analysis_queue')?.items.length, 0);
    assert.equal(collections.find((source) => source.source === 'reconciliation')?.health, 'partial');
  } finally {
    f.close();
  }
});
test('queue severity remains null; Capella confirmation stays static', () => {
  const queue = normalizeFinding(
    'ws',
    'analysis_queue',
    'analysis',
    { ID: 'INJ-01', confidence: 'high' },
    ref,
    '/vulnerabilities/0',
  );
  assert.equal(queue.severity, null);
  assert.equal(queue.confidence, 'high');
  assert.equal(queue.confirmation, 'unknown');
  const staticFinding = normalizeFinding(
    'ws',
    'capella',
    'sast',
    {
      id: 'c-1',
      severity: 'HIGH',
      repro_status: 'statically_confirmed',
      status: 'VALID',
      code_paths: ['src/router.ts:4'],
    },
    ref,
    '/value/findings/0',
  );
  assert.equal(staticFinding.severity, 'high');
  assert.equal(staticFinding.confirmation, 'static');
  assert.notEqual(staticFinding.confirmation, 'exploited');
  assert.equal(staticFinding.confidence, null);
});

test('an empty draft is never selected as the default final report', () => {
  const result = projectFindings(
    'ws',
    [
      { source: 'analysis_queue', items: [], health: 'fresh', complete: true },
      { source: 'final_report', stage: 'report-draft', items: [], health: 'fresh', complete: true },
    ],
    new URLSearchParams(),
  );
  assert.deepEqual(result.selectedSources, ['analysis_queue']);
});
test('normalization keeps artifact provenance and excludes auth-state/cookies/raw prompts', () => {
  const f = normalizeFinding(
    'ws',
    'final_report',
    'report-finalized',
    {
      finding_id: 'INJ-01',
      title: 'SQL injection',
      notes: 'Cookie: sid=secret-cookie\nAPI_KEY=secret-key\nBearer secret-bearer',
      auth_state: { password: 'private' },
      prompt: 'raw prompt content',
      tool_arguments: 'secret arguments',
    },
    ref,
    '/findings/0',
  );
  const serialized = JSON.stringify(f);
  for (const secret of [
    'secret-cookie',
    'secret-key',
    'secret-bearer',
    'private',
    'raw prompt content',
    'secret arguments',
  ])
    assert.equal(serialized.includes(secret), false);
  assert.equal(f.provenance[0]?.jsonPointer, '/findings/0');
  assert.equal(f.identityScope, 'artifact-version');
  assert.equal(
    f.dashboardId,
    normalizeFinding('ws', 'final_report', 'report-finalized', { finding_id: 'INJ-01' }, ref, '/findings/0')
      .dashboardId,
  );
});
test('multiple sources do not inflate the default final vulnerability count; signed cursors are revision-bound', () => {
  const q = normalizeFinding('ws', 'analysis_queue', 'analysis', { ID: 'INJ-01' }, ref, '/vulnerabilities/0');
  const final = normalizeFinding(
    'ws',
    'final_report',
    'report-finalized',
    { finding_id: 'INJ-01' },
    ref,
    '/findings/0',
  );
  const collections: FindingCollection[] = [
    { source: 'analysis_queue', items: [q], health: 'fresh', complete: true },
    {
      source: 'final_report',
      stage: 'report-finalized',
      items: [final, { ...final, dashboardId: 'other' }],
      health: 'fresh',
      complete: true,
    },
  ];
  const data = projectFindings('ws', collections, new URLSearchParams({ limit: '1' }));
  assert.deepEqual(data.selectedSources, ['final_report']);
  assert.equal(data.page.total, 2);
  assert.notEqual(q.dashboardId, final.dashboardId);
  assert.ok(data.page.nextCursor);
  assert.throws(
    () =>
      projectFindings(
        'ws',
        [{ ...(collections[1] as FindingCollection), items: [] }],
        new URLSearchParams({ limit: '1', cursor: data.page.nextCursor as string }),
      ),
    /Findings changed/,
  );
});
