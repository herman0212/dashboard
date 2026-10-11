import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { validateCredentials } from '../../cli/src/env.js';
import { GENERIC_API_KEY_ENV, PROVIDER_API_KEY_ENV, PROVIDER_EXTRA_ENV } from '../../cli/src/model-spec.js';
import type { ControlCapabilities } from '../src/contracts.js';
import { type DashboardConfig, repositoryRoot } from '../src/server/config.js';
import { type LaunchCommand, ScanControls } from '../src/server/control.js';
import { dashboardServer } from '../src/server/index.js';
import { addressPolicy, checkTargetPolicy } from '../src/server/target-policy.js';
import { startScanReady } from '../src/web/start-readiness.js';

const listen = (server: Server): Promise<string> =>
  new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
const close = (server: Server): Promise<void> =>
  new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
const failure = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;
test('existing CLI credential validator rejects missing/invalid models and accepts a configured provider without returning keys', () => {
  const keys = [
    'ASTRA_AI_MODEL',
    'ASTRA_USE_PI_AUTH',
    GENERIC_API_KEY_ENV,
    ...Object.values(PROVIDER_API_KEY_ENV).flat(),
    ...Object.values(PROVIDER_EXTRA_ENV).flat(),
  ];
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    assert.equal(validateCredentials().valid, false);
    process.env.ASTRA_AI_MODEL = 'openai:fixture-model';
    process.env[GENERIC_API_KEY_ENV] = 'unit-test-key';
    assert.deepEqual(validateCredentials(), { valid: true });
    process.env.ASTRA_AI_MODEL = ':';
    assert.equal(validateCredentials().valid, false);
    assert.equal(JSON.stringify(validateCredentials()).includes('unit-test-key'), false);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
function fixture() {
  const parent = path.resolve(process.env.ASTRA_DASHBOARD_TEST_TMP ?? os.tmpdir());
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'astra-runner-test-'));
  const source = path.join(root, 'source');
  fs.mkdirSync(source);
  const config: DashboardConfig = {
    workspaceRoot: path.join(root, 'workspaces'),
    webRoot: path.join(repositoryRoot, 'apps/dashboard/dist/web'),
    port: 0,
    maxConcurrent: 8,
    control: { repositoryRoots: [source], stateDirectory: path.join(root, 'control') },
  };
  const cleanup = () => {
    assert.equal(path.dirname(root), parent);
    assert.ok(path.basename(root).startsWith('astra-runner-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  };
  return { source, config, cleanup };
}

test('Start requires current readiness, a valid target, a listed source and explicit authorization', () => {
  const config: ControlCapabilities = {
    csrfToken: 'a'.repeat(64),
    available: true,
    reason: null,
    repositoryRoots: ['/source'],
    workspaceRoot: '/workspaces',
  };
  const ready = (
    url = 'https://owned.example',
    repo = '/source',
    auth = true,
    busy = false,
    stale = false,
    caps = config,
  ) => startScanReady(caps, url, repo, auth, busy, stale);
  assert.equal(ready(), true);
  for (const url of [
    '',
    'file:///secret',
    'http:example',
    'https://user:secret@example.com',
    'https://example.com/#x',
    'https://example.com/\n',
  ])
    assert.equal(ready(url), false);
  assert.equal(ready(undefined, '/other'), false);
  assert.equal(ready(undefined, undefined, false), false);
  assert.equal(ready(undefined, undefined, undefined, true), false);
  assert.equal(ready(undefined, undefined, undefined, undefined, true), false);
  assert.equal(ready(undefined, undefined, undefined, undefined, undefined, { ...config, available: false }), false);
  assert.equal(startScanReady(null, 'https://owned.example', '/source', true, false, false), false);
});

test('target policy rejects private/reserved/mixed DNS and metadata, including encoded IPv4 and mapped IPv6', async () => {
  for (const ip of [
    '127.0.0.1',
    '10.1.2.3',
    '172.16.2.1',
    '192.168.1.1',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    'fc00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '2002:7f00:1::',
  ])
    assert.equal(addressPolicy(ip, false), false, ip);
  assert.equal(addressPolicy('8.8.8.8', false), true);
  assert.equal(addressPolicy('2606:4700:4700::1111', false), true);
  for (const ip of ['169.254.169.254', '::ffff:169.254.169.254', 'fd00:ec2::254'])
    assert.equal(addressPolicy(ip, true), false, ip);
  for (const url of [
    'http://2130706433',
    'http://0x7f000001',
    'http://[::ffff:127.0.0.1]',
    'http://metadata.google.internal',
  ])
    await assert.rejects(checkTargetPolicy(new URL(url)), failure('TargetBlocked'));
  await checkTargetPolicy(new URL('http://127.0.0.1:3000'), ['127.0.0.1']);
  await assert.rejects(
    checkTargetPolicy(new URL('http://169.254.169.254'), ['169.254.169.254']),
    failure('TargetBlocked'),
  );
  const mixed = (async () => [
    { address: '8.8.8.8', family: 4 },
    { address: '10.0.0.1', family: 4 },
  ]) as Parameters<typeof checkTargetPolicy>[2];
  await assert.rejects(checkTargetPolicy(new URL('https://owned.example'), [], mixed), failure('TargetBlocked'));
  const unavailable = (async () => {
    throw new Error('private resolver error');
  }) as Parameters<typeof checkTargetPolicy>[2];
  await assert.rejects(
    checkTargetPolicy(new URL('https://owned.example'), [], unavailable),
    failure('TargetDnsUnavailable'),
  );
});

test('Docker/model readiness failures disable controls and prevent launch; recovery is observed on the next check', async () => {
  const f = fixture();
  let problems = [
    { code: 'DockerUnavailable', message: 'Docker is inaccessible.' },
    { code: 'ModelCredentialsUnavailable', message: 'Credentials are missing.' },
  ];
  let launched = false;
  const controls = new ScanControls(f.config, {
    platform: 'linux',
    uid: 1000,
    readiness: async () => problems,
    targetCheck: async () => {},
    launch: () => {
      launched = true;
      throw new Error('fixture');
    },
  });
  try {
    const capabilities = await controls.getCapabilities();
    assert.equal(capabilities.available, false);
    assert.equal(capabilities.issues?.length, 2);
    await assert.rejects(
      controls.submit('start', {
        requestId: randomUUID(),
        url: 'https://owned.example',
        repository: f.source,
        authorized: true,
      }),
      failure('ControlUnavailable'),
    );
    assert.equal(launched, false);
    assert.equal(fs.existsSync(f.config.workspaceRoot), false);
    problems = [];
    assert.equal((await controls.getCapabilities()).available, true);
    problems = [{ code: 'ModelCredentialsUnavailable', message: 'Credentials are missing.' }];
    assert.equal((await controls.getCapabilities()).stopAvailable, true);
    fs.mkdirSync(path.join(f.config.workspaceRoot, 'existing-scan'), { recursive: true });
    assert.equal(
      (await controls.submit('stop', { requestId: randomUUID(), confirmed: true }, 'existing-scan')).processState,
      'failed',
    );
    const root = new ScanControls(f.config, { platform: 'linux', uid: 0, readiness: async () => [] });
    assert.equal((await root.getCapabilities()).available, false);
    const sudo = new ScanControls(f.config, { platform: 'linux', uid: 1000, sudo: true, readiness: async () => [] });
    assert.equal((await sudo.getCapabilities()).available, false);
  } finally {
    f.cleanup();
  }
});

test('Windows adapter fails closed when runner is unreachable, unauthenticated, or not Linux', async () => {
  const f = fixture();
  const runner = dashboardServer({ ...f.config, runnerToken: 'b'.repeat(64) }, undefined, { platform: 'win32' });
  const runnerUrl = await listen(runner);
  const adapter = dashboardServer({ ...f.config, remoteRunner: { url: runnerUrl, token: 'a'.repeat(64) } });
  const base = await listen(adapter);
  try {
    const result = await (await fetch(`${base}/api/control/capabilities`)).json();
    assert.equal(result.data.available, false);
    assert.equal(result.data.issues[0].code, 'RunnerAuthenticationFailed');
    assert.equal((await fetch(`${runnerUrl}/api/scans`)).status, 401);
    assert.equal((await fetch(`${runnerUrl}/`)).status, 404);
  } finally {
    await close(adapter);
  }
  const wrongRuntime = dashboardServer({ ...f.config, remoteRunner: { url: runnerUrl, token: 'b'.repeat(64) } });
  const wrongBase = await listen(wrongRuntime);
  try {
    const result = await (await fetch(`${wrongBase}/api/control/capabilities`)).json();
    assert.equal(result.data.issues[0].code, 'RunnerProtocolInvalid');
  } finally {
    await close(wrongRuntime);
    await close(runner);
  }
  const unavailable = dashboardServer({ ...f.config, remoteRunner: { url: runnerUrl, token: 'b'.repeat(64) } });
  const failedBase = await listen(unavailable);
  try {
    const result = await (await fetch(`${failedBase}/api/control/capabilities`)).json();
    assert.equal(result.data.available, false);
    assert.equal(result.data.issues[0].code, 'RunnerUnavailable');
    assert.equal((await fetch(`${failedBase}/api/scans`)).status, 503);
  } finally {
    await close(unavailable);
    f.cleanup();
  }
});

test('authenticated adapter routes structured requests and real filesystem reads to the same runner; fixtures do not prove a pentest', async () => {
  const f = fixture();
  const commands: LaunchCommand[] = [];
  const token = 'c'.repeat(64);
  const runner = dashboardServer({ ...f.config, runnerToken: token }, undefined, {
    platform: 'linux',
    uid: 1000,
    readiness: async () => [],
    targetCheck: async () => {},
    launch: (command) => {
      commands.push(command);
      const child = Object.assign(new EventEmitter(), { pid: 1234 });
      queueMicrotask(() => child.emit('spawn'));
      return child as ChildProcess;
    },
  });
  const runnerUrl = await listen(runner);
  const adapter = dashboardServer({ ...f.config, remoteRunner: { url: runnerUrl, token } });
  const base = await listen(adapter);
  try {
    const capabilities = await (await fetch(`${base}/api/control/capabilities`)).json();
    assert.equal(capabilities.data.available, true);
    assert.equal(capabilities.data.runtime, 'linux');
    assert.equal(JSON.stringify(capabilities).includes(token), false);
    const headers = {
      origin: base,
      'content-type': 'application/json',
      'x-astra-control': capabilities.data.csrfToken,
    };
    const input = { requestId: randomUUID(), url: 'https://owned.example', repository: f.source, authorized: true };
    assert.equal((await fetch(`${base}/api/scans`, { method: 'POST', body: JSON.stringify(input) })).status, 403);
    assert.equal(
      (
        await fetch(`${base}/api/scans`, {
          method: 'POST',
          headers: { ...headers, origin: 'https://foreign.example' },
          body: JSON.stringify(input),
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${base}/api/scans`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ ...input, command: 'echo private' }),
        })
      ).status,
      400,
    );
    const launched = await fetch(`${base}/api/scans`, { method: 'POST', headers, body: JSON.stringify(input) });
    assert.equal(launched.status, 202);
    const operation = (await launched.json()).data;
    const repeated = await fetch(`${base}/api/scans`, { method: 'POST', headers, body: JSON.stringify(input) });
    assert.equal((await repeated.json()).data.id, operation.id);
    assert.equal(commands.length, 1);
    assert.equal(commands[0]?.args[1], 'start');
    assert.equal(
      (
        await fetch(`${base}/api/scans`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ ...input, requestId: randomUUID() }),
        })
      ).status,
      409,
    );
    const internal = path.join(f.config.workspaceRoot, operation.workspace, '.astra');
    fs.mkdirSync(internal, { recursive: true });
    fs.writeFileSync(path.join(internal, 'session.json'), JSON.stringify({ session: { webUrl: input.url } }));
    const listing = await (await fetch(`${base}/api/scans`)).json();
    assert.equal(listing.data.total, 1);
    assert.equal(listing.data.items[0].workspace, operation.workspace);
    const history = await (await fetch(`${base}/api/control/operations`)).json();
    assert.equal(history.data[0].id, operation.id);
    assert.equal('env' in history.data[0], false);
  } finally {
    await close(adapter);
    await close(runner);
    f.cleanup();
  }
});
