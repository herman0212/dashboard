import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { dashboardServer } from '../src/server/index.js';
import { createSnapshots } from '../src/server/snapshot.js';
import { execution, fixture, treeDigest } from './helpers.js';

test('read-only API serves all seven routes, sanitizes output, rejects writes/paths/origins and preserves workspace bytes', async () => {
  const f = fixture();
  fs.writeFileSync(
    path.join(f.workspace, '.astra/workflow.log'),
    '[2026-01-01 00:00:00] [recon] bash: {"command":"Cookie: private-cookie"}\n',
  );
  fs.writeFileSync(
    path.join(f.workspace, '.astra/deliverables/pre_recon_deliverable.md'),
    '# Analysis\nAPI_KEY=private-key',
  );
  fs.writeFileSync(path.join(f.workspace, '.astra/auth-state.json'), '{"cookies":[{"value":"private-auth-cookie"}]}');
  const before = treeDigest(f.workspace);
  const server = dashboardServer({ ...f.config, port: 0 }, async () => ({
    execution: execution(),
    health: 'fresh',
    observedAt: new Date().toISOString(),
    reasonCode: null,
  }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const scan = `/api/scans/${f.name}`;
  try {
    for (const route of [
      '/api/scans',
      scan,
      `${scan}/findings`,
      `${scan}/logs`,
      `${scan}/deliverables`,
      `${scan}/report`,
    ]) {
      const response = await fetch(base + route);
      assert.equal(response.status, 200, route);
      const text = await response.text();
      for (const secret of ['private-cookie', 'private-key', 'private-auth-cookie', 'never-publish'])
        assert.equal(text.includes(secret), false, route);
    }
    assert.equal((await fetch(`${base + scan}/artifacts/${'a'.repeat(64)}`)).status, 404);
    assert.equal((await fetch(base + scan, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${base + scan}?path=auth-state.json`)).status, 400);
    assert.equal((await fetch(`${base + scan}/artifacts/%2e%2e%2fsecret`)).status, 400);
    assert.equal((await fetch(base + scan, { headers: { Origin: 'https://foreign.example' } })).status, 403);
    assert.equal((await fetch(`${base}/api/scans?limit=201`)).status, 400);
    assert.equal(treeDigest(f.workspace), before);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
    f.close();
  }
});
test('a resume during read is an identity conflict, not an old execution painted over a new one', async () => {
  const f = fixture();
  try {
    const snapshots = createSnapshots(f.config, async () => {
      f.session.session.originalWorkflowId = 'new-workflow';
      f.save();
      return { execution: execution(), health: 'fresh', observedAt: new Date().toISOString(), reasonCode: null };
    });
    await assert.rejects(
      () => snapshots.get(f.name),
      (error: unknown) =>
        (error as { status?: number; code?: string }).status === 409 &&
        (error as { code?: string }).code === 'ExecutionChanged',
    );
  } finally {
    f.close();
  }
});
test('duplicate workflow claims are rejected', async () => {
  const f = fixture();
  try {
    fs.mkdirSync(path.join(f.root, 'duplicate/.astra'), { recursive: true });
    fs.copyFileSync(path.join(f.workspace, '.astra/session.json'), path.join(f.root, 'duplicate/.astra/session.json'));
    const snapshots = createSnapshots(f.config, async () => ({
      execution: execution(),
      health: 'fresh',
      observedAt: new Date().toISOString(),
      reasonCode: null,
    }));
    await assert.rejects(
      () => snapshots.get(f.name),
      (error: unknown) => (error as { code?: string }).code === 'IdentityConflict',
    );
  } finally {
    f.close();
  }
});
