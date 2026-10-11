import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import { request as httpRequest } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { getWorkspacesDir, initHome } from '../../cli/src/home.js';
import { setMode } from '../../cli/src/mode.js';
import type { DashboardConfig } from '../src/server/config.js';
import { repositoryRoot } from '../src/server/config.js';
import { type LaunchCommand, ScanControls, validateRepository, validateTarget } from '../src/server/control.js';
import { dashboardServer } from '../src/server/index.js';
import { execution } from './helpers.js';

function controlFixture() {
  const parent = path.resolve(process.env.ASTRA_DASHBOARD_TEST_TMP ?? os.tmpdir());
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'astra-controls-test-'));
  const repository = path.join(root, 'source');
  fs.mkdirSync(repository);
  const config: DashboardConfig = {
    workspaceRoot: path.join(root, 'workspaces'),
    webRoot: path.join(repositoryRoot, 'apps/dashboard/dist/web'),
    port: 0,
    maxConcurrent: 8,
    control: { repositoryRoots: [fs.realpathSync(repository)], stateDirectory: path.join(root, 'control') },
  };
  const input = () => ({ requestId: randomUUID(), url: 'https://authorized.example/', repository, authorized: true });
  const close = () => {
    if (path.dirname(root) !== parent || !path.basename(root).startsWith('astra-controls-test-'))
      throw new Error('Unsafe cleanup');
    fs.rmSync(root, { recursive: true, force: true });
  };
  return { root, repository, config, input, close };
}
function launcher() {
  const commands: LaunchCommand[] = [];
  const children: EventEmitter[] = [];
  const launch = (command: LaunchCommand): ChildProcess => {
    commands.push(command);
    const child = Object.assign(new EventEmitter(), { pid: 12345 });
    children.push(child);
    queueMicrotask(() => child.emit('spawn'));
    return child as ChildProcess;
  };
  return { commands, children, launch };
}
const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;
const rawGetStatus = (url: string, headers: Record<string, string>): Promise<number | undefined> =>
  new Promise((resolve, reject) => {
    httpRequest(url, { headers }, (response) => {
      response.resume();
      resolve(response.statusCode);
    })
      .on('error', reject)
      .end();
  });

test('target and repository validation rejects commands, traversal, credentials and mount syntax', () => {
  const f = controlFixture();
  try {
    for (const value of [
      'file:///secret',
      'https://user:password@example.test',
      'http://localhost/#x',
      'https://example.test/\n--all',
      '--url',
      'http:example.test',
      12,
    ])
      assert.throws(() => validateTarget(value), code('InvalidTarget'));
    assert.equal(validateTarget('http://127.0.0.1:3000').href, 'http://127.0.0.1:3000/');
    assert.equal(validateRepository(f.repository, [f.repository]), fs.realpathSync(f.repository));
    assert.throws(
      () => validateRepository(`${path.join(f.repository, '..', 'other')}/..`, [f.repository]),
      code('InvalidRepository'),
    );
    assert.throws(() => validateRepository(`${f.repository}-other`, [f.repository]), code('RepositoryBlocked'));
    assert.throws(() => validateRepository('relative/source', [f.repository]), code('InvalidRepository'));
    assert.throws(
      () => validateRepository(path.join(f.repository, 'missing'), [f.repository]),
      code('RepositoryUnavailable'),
    );
    const comma = path.join(f.repository, 'bad,mount');
    fs.mkdirSync(comma);
    assert.throws(() => validateRepository(comma, [f.repository]), code('RepositoryUnavailable'));
  } finally {
    f.close();
  }
});

test('repository symlink escape is blocked on filesystems that support creating links', (t) => {
  const f = controlFixture();
  try {
    const outside = path.join(f.root, 'outside');
    fs.mkdirSync(outside);
    const link = path.join(f.repository, 'escape');
    try {
      fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        t.skip('Windows sandbox cannot create a symlink/junction.');
        return;
      }
      throw error;
    }
    assert.throws(() => validateRepository(link, [f.repository]), code('RepositoryUnavailable'));
  } finally {
    f.close();
  }
});

test('repository link rejection executes even when junction creation is unavailable', () => {
  const f = controlFixture();
  const original = fs.lstatSync;
  try {
    const link = path.join(f.repository, 'link');
    fs.mkdirSync(link);
    Reflect.set(fs, 'lstatSync', ((value: fs.PathLike) => {
      const stat = original(value);
      if (String(value) === link) stat.isSymbolicLink = () => true;
      return stat;
    }) as typeof fs.lstatSync);
    assert.throws(() => validateRepository(link, [f.repository]), code('RepositoryUnavailable'));
  } finally {
    Reflect.set(fs, 'lstatSync', original);
    f.close();
  }
});

test('controller records cannot be placed inside the worker workspace mount', () => {
  const f = controlFixture();
  try {
    assert.throws(
      () =>
        new ScanControls({
          ...f.config,
          control: { repositoryRoots: [f.repository], stateDirectory: path.join(f.config.workspaceRoot, 'unsafe') },
        }),
      /outside the worker/,
    );
  } finally {
    f.close();
  }
});

test('CLI defaults remain local/npx; trusted workspace override is also used by initialization', () => {
  const f = controlFixture();
  const previous = process.env.ASTRA_WORKSPACES_DIR;
  try {
    delete process.env.ASTRA_WORKSPACES_DIR;
    setMode('local');
    assert.equal(getWorkspacesDir(), path.resolve('workspaces'));
    setMode('npx');
    assert.equal(getWorkspacesDir(), path.join(os.homedir(), '.astra/workspaces'));
    process.env.ASTRA_WORKSPACES_DIR = f.config.workspaceRoot;
    assert.equal(getWorkspacesDir(), f.config.workspaceRoot);
    initHome();
    assert.equal(fs.statSync(f.config.workspaceRoot).isDirectory(), true);
  } finally {
    if (previous === undefined) delete process.env.ASTRA_WORKSPACES_DIR;
    else process.env.ASTRA_WORKSPACES_DIR = previous;
    setMode('local');
    f.close();
  }
});

test('start uses existing Astra argv; authorization, unknown fields, idempotency and duplicates are enforced', async () => {
  const f = controlFixture();
  const fake = launcher();
  const controls = new ScanControls(f.config, {
    ...fake,
    platform: 'linux',
    uid: 1000,
    readiness: async () => [],
    targetCheck: async () => {},
  });
  const input = f.input();
  try {
    await assert.rejects(controls.submit('start', { ...input, authorized: false }), code('ConfirmationRequired'));
    await assert.rejects(controls.submit('start', { ...input, shell: 'arbitrary' }), code('InvalidControlRequest'));
    await assert.rejects(
      controls.submit('start', { ...input, requestId: [input.requestId] }),
      code('InvalidControlRequest'),
    );
    const operation = await controls.submit('start', input);
    assert.equal(fake.commands.length, 1);
    const command = fake.commands[0];
    assert.ok(command);
    assert.deepEqual(command.args, [
      path.join(repositoryRoot, 'astra'),
      'start',
      '--url',
      input.url,
      '--repo',
      fs.realpathSync(f.repository),
      '--workspace',
      operation.workspace,
    ]);
    assert.equal(command.cwd, repositoryRoot);
    assert.equal(command.env.ASTRA_WORKSPACES_DIR, f.config.workspaceRoot);
    assert.equal((await controls.submit('start', input)).id, operation.id);
    await assert.rejects(
      controls.submit('start', { ...input, url: 'https://another.example/' }),
      code('IdempotencyConflict'),
    );
    await assert.rejects(controls.submit('start', { ...input, requestId: randomUUID() }), code('ScanAlreadyActive'));
    assert.equal(fake.commands.length, 1);
    assert.equal(
      fs.existsSync(path.join(f.config.workspaceRoot, operation.workspace)),
      false,
      'only CLI may create scan workspace',
    );
    const ipv6 = await controls.submit('start', { ...input, requestId: randomUUID(), url: 'http://[::1]:3000/' });
    assert.match(ipv6.workspace, /^scan-/);
  } finally {
    f.close();
  }
});

test('failed spawn is recorded without exposing its error; failed requests can be retried safely', async () => {
  const f = controlFixture();
  const controls = new ScanControls(f.config, {
    platform: 'linux',
    uid: 1000,
    readiness: async () => [],
    targetCheck: async () => {},
    launch: () => {
      throw new Error('API_KEY=private-secret');
    },
  });
  try {
    const input = f.input();
    const failed = await controls.submit('start', input);
    assert.equal(failed.processState, 'failed');
    assert.equal(failed.error?.code, 'LauncherSpawnFailed');
    assert.equal(JSON.stringify(controls.list()).includes('private-secret'), false);
    assert.equal((await controls.submit('start', { ...input, requestId: randomUUID() })).processState, 'failed');
  } finally {
    f.close();
  }
});

test('real Node subprocess lifecycle records spawn and failed exit', async () => {
  const f = controlFixture();
  let spawned: Promise<unknown> = Promise.resolve();
  let closed: Promise<unknown> = Promise.resolve();
  const controls = new ScanControls(f.config, {
    platform: 'linux',
    uid: 1000,
    readiness: async () => [],
    targetCheck: async () => {},
    launch: () => {
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(7), 100)'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      spawned = once(child, 'spawn');
      closed = once(child, 'close');
      return child;
    },
  });
  try {
    const operation = await controls.submit('start', f.input());
    await spawned;
    assert.equal(controls.get(operation.id).processState, 'running');
    await closed;
    assert.equal(controls.get(operation.id).exitCode, 7);
    assert.equal(controls.get(operation.id).processState, 'failed');
    assert.equal(controls.get(operation.id).error?.code, 'LauncherFailed');
  } finally {
    f.close();
  }
});

test('restart preserves idempotency, marks observation unknown and fails closed on mutex or unverified scan', async () => {
  const f = controlFixture();
  const fake = launcher();
  const input = f.input();
  const controls = new ScanControls(f.config, {
    ...fake,
    platform: 'linux',
    uid: 1000,
    readiness: async () => [],
    targetCheck: async () => {},
  });
  try {
    const operation = await controls.submit('start', input);
    const restarted = new ScanControls(f.config, {
      ...fake,
      platform: 'linux',
      uid: 1000,
      readiness: async () => [],
      targetCheck: async () => {},
    });
    assert.equal(restarted.get(operation.id).processState, 'unknown');
    assert.equal((await restarted.submit('start', input)).id, operation.id);
    await assert.rejects(restarted.submit('start', { ...input, requestId: randomUUID() }), code('ScanAlreadyActive'));
    fs.writeFileSync(path.join(f.root, 'control/mutation.lock'), '');
    await assert.rejects(
      restarted.submit('start', { ...input, requestId: randomUUID(), url: 'https://different.example/' }),
      code('ControlBusy'),
    );
    assert.equal(fake.commands.length, 1);
  } finally {
    f.close();
  }
});

test('CLI exit zero does not release duplicate guard; only a fresh terminal Temporal observation allows another scan', async () => {
  const f = controlFixture();
  const fake = launcher();
  let status = 'RUNNING';
  const controls = new ScanControls(f.config, {
    ...fake,
    platform: 'linux',
    uid: 1000,
    readiness: async () => [],
    targetCheck: async () => {},
    temporal: async () => ({
      execution: execution({ status }),
      health: 'fresh',
      observedAt: new Date().toISOString(),
      reasonCode: null,
    }),
  });
  try {
    const input = f.input();
    const operation = await controls.submit('start', input);
    const internal = path.join(f.config.workspaceRoot, operation.workspace, '.astra');
    fs.mkdirSync(internal, { recursive: true });
    fs.writeFileSync(
      path.join(internal, 'session.json'),
      JSON.stringify({ session: { originalWorkflowId: 'fixture-workflow', webUrl: input.url } }),
    );
    fake.children[0]?.emit('close', 0, null);
    assert.equal(controls.get(operation.id).processState, 'exited');
    await assert.rejects(controls.submit('start', { ...input, requestId: randomUUID() }), code('ScanAlreadyActive'));
    status = 'COMPLETED';
    await controls.submit('start', { ...input, requestId: randomUUID() });
    assert.equal(fake.commands.length, 2);
  } finally {
    f.close();
  }
});

test('stop uses existing CLI cancellation command for one workspace, never --all', async () => {
  const f = controlFixture();
  const fake = launcher();
  const controls = new ScanControls(f.config, {
    ...fake,
    platform: 'linux',
    uid: 1000,
    readiness: async () => [],
    targetCheck: async () => {},
  });
  try {
    fs.mkdirSync(path.join(f.config.workspaceRoot, 'known-scan'), { recursive: true });
    const input = { requestId: randomUUID(), confirmed: true };
    await assert.rejects(
      controls.submit('stop', { ...input, confirmed: false }, 'known-scan'),
      code('ConfirmationRequired'),
    );
    await assert.rejects(controls.submit('stop', input, '../outside'), code('InvalidIdentifier'));
    const operation = await controls.submit('stop', input, 'known-scan');
    assert.deepEqual(fake.commands[0]?.args, [path.join(repositoryRoot, 'astra'), 'stop', 'known-scan', '--yes']);
    assert.equal((await controls.submit('stop', input, 'known-scan')).id, operation.id);
    await assert.rejects(
      controls.submit('stop', { ...input, requestId: randomUUID() }, 'known-scan'),
      code('ScanAlreadyActive'),
    );
  } finally {
    f.close();
  }
});

test('HTTP controls require matching Origin/token/JSON and reject foreign websites, oversized bodies and arbitrary fields', async () => {
  const f = controlFixture();
  const fake = launcher();
  const server = dashboardServer(f.config, undefined, {
    ...fake,
    platform: 'linux',
    uid: 1000,
    readiness: async () => [],
    targetCheck: async () => {},
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const capabilities = await (await fetch(`${base}/api/control/capabilities`)).json();
    const headers = {
      origin: base,
      'content-type': 'application/json',
      'x-astra-control': capabilities.data.csrfToken,
    };
    const body = JSON.stringify(f.input());
    assert.equal((await fetch(`${base}/api/scans`, { method: 'POST', body })).status, 403);
    assert.equal(
      (
        await fetch(`${base}/api/scans`, {
          method: 'POST',
          headers: { ...headers, origin: 'https://foreign.example' },
          body,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${base}/api/scans`, {
          method: 'POST',
          headers: { ...headers, 'x-astra-control': '0'.repeat(64) },
          body,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${base}/api/scans`, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'text/plain' },
          body,
        })
      ).status,
      415,
    );
    assert.equal((await fetch(`${base}/api/scans`, { method: 'POST', headers, body: 'invalid' })).status, 400);
    assert.equal(
      (
        await fetch(`${base}/api/scans`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ ...f.input(), shell: 'echo private' }),
        })
      ).status,
      400,
    );
    assert.equal((await fetch(`${base}/api/scans`, { method: 'POST', headers, body: 'x'.repeat(8193) })).status, 413);
    assert.equal((await fetch(`${base}/api/scans`, { method: 'POST', headers, body })).status, 202);
    assert.equal(fake.commands.length, 1);
    const history = await (await fetch(`${base}/api/control/operations`)).json();
    assert.equal(history.data.length, 1);
    assert.equal('env' in history.data[0], false);
    assert.equal('fingerprint' in history.data[0], false);
    assert.equal((await fetch(`${base}/api/control/operations/${history.data[0].id}`)).status, 200);
    assert.equal(await rawGetStatus(`${base}/api/control/capabilities`, { Host: 'evil.example' }), 403);
    assert.equal(await rawGetStatus(`${base}/api/control/capabilities`, { 'sec-fetch-site': 'cross-site' }), 403);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    f.close();
  }
});

test('native Windows controls are explicitly unavailable and create no scan or operation', async () => {
  const f = controlFixture();
  const fake = launcher();
  const controls = new ScanControls(f.config, { ...fake, platform: 'win32' });
  try {
    assert.equal(controls.capabilities.available, false);
    assert.match(controls.capabilities.reason ?? '', /WSL2/);
    await assert.rejects(controls.submit('start', f.input()), code('ControlUnavailable'));
    assert.equal(fake.commands.length, 0);
    assert.equal(fs.existsSync(f.config.workspaceRoot), false);
  } finally {
    f.close();
  }
});
