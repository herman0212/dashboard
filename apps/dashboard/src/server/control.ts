import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { dashboardRuntimeReadiness } from '@keygraph/astra/dashboard-runtime';
import type { ControlCapabilities, ControlOperation } from '../contracts.js';
import { type DashboardConfig, repositoryRoot } from './config.js';
import { readTemporal } from './readers/temporal-reader.js';
import { listWorkspaceNames, readWorkspace } from './readers/workspace-reader.js';
import { sendJson } from './routes.js';
import { contained, digest, HttpError, identifier, record, safePath, safeRead, safeUrl } from './security.js';
import { metadata, type TemporalReader } from './snapshot.js';
import { checkTargetPolicy } from './target-policy.js';

export interface LaunchCommand {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}
export interface ControlDependencies {
  launch?: (command: LaunchCommand) => ChildProcess;
  platform?: NodeJS.Platform;
  uid?: number;
  sudo?: boolean;
  temporal?: TemporalReader;
  readiness?: () => Promise<{ code: string; message: string }[]>;
  targetCheck?: (target: URL) => Promise<void>;
}
interface StoredOperation extends ControlOperation {
  fingerprint: string;
  requestFingerprint: string;
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const terminal = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'TERMINATED', 'TIMED_OUT']);
const messages = {
  LauncherFailed: 'Astra CLI failed. Check Docker, credentials and the scan detail for startup errors.',
  LauncherSpawnFailed: 'The Astra CLI process could not be started. Check the local runtime and permissions.',
  ObservationLost: 'Dashboard restarted; launcher status is unknown. Check the workspace and Temporal status.',
  JournalUnavailable: 'The launcher state could not be persisted. Do not retry until workspace status is verified.',
} as const;
const messageFor = (code: string): string => messages[code as keyof typeof messages] ?? messages.JournalUnavailable;
const hasControlCharacters = (value: string) =>
  Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
function publicOperation(value: StoredOperation): ControlOperation {
  return {
    id: value.id,
    kind: value.kind,
    workspace: value.workspace,
    requestedAt: value.requestedAt,
    updatedAt: value.updatedAt,
    processState: value.processState,
    pid: value.pid,
    exitCode: value.exitCode,
    signal: value.signal,
    error: value.error ? { code: value.error.code, message: messageFor(value.error.code) } : null,
  };
}
export function validateTarget(value: unknown): URL {
  if (
    typeof value !== 'string' ||
    value.length > 2048 ||
    !/^https?:\/\//i.test(value) ||
    /\s/.test(value) ||
    hasControlCharacters(value)
  )
    throw new HttpError(400, 'InvalidTarget', 'Enter a valid HTTP(S) target URL.');
  let target: URL;
  try {
    target = new URL(value);
  } catch {
    throw new HttpError(400, 'InvalidTarget', 'Enter an absolute HTTP(S) target URL.');
  }
  if (
    !['http:', 'https:'].includes(target.protocol) ||
    !target.hostname ||
    target.username ||
    target.password ||
    target.hash
  )
    throw new HttpError(400, 'InvalidTarget', 'Only HTTP(S) URLs without credentials or fragments are supported.');
  return target;
}
export function validateRepository(value: unknown, roots: string[]): string {
  if (
    typeof value !== 'string' ||
    value.length > 4096 ||
    !path.isAbsolute(value) ||
    hasControlCharacters(value) ||
    value.split(/[\\/]/).includes('..') ||
    (process.platform === 'win32' && value.slice(2).includes(':'))
  )
    throw new HttpError(
      400,
      'InvalidRepository',
      'Enter an absolute source directory inside an allowed repository root.',
    );
  const root = roots.find((allowed) => contained(allowed, value));
  if (!root) throw new HttpError(403, 'RepositoryBlocked', 'Source directory is outside the allowed repository roots.');
  try {
    const resolved = path.resolve(value) === root ? root : safePath(root, path.relative(root, value));
    if (fs.lstatSync(resolved).isSymbolicLink() || !fs.statSync(resolved).isDirectory()) throw new Error('directory');
    const canonical = fs.realpathSync(resolved);
    if (!contained(root, canonical)) throw new Error('outside');
    // These paths become Docker bind mounts; ':' and ',' are mount syntax, not source paths.
    if (canonical.includes(',') || (process.platform !== 'win32' && canonical.includes(':')))
      throw new Error('mount syntax');
    return canonical;
  } catch {
    throw new HttpError(
      400,
      'RepositoryUnavailable',
      'Source directory is missing, inaccessible or contains a blocked link.',
    );
  }
}
function validateBody(body: unknown, keys: string[]): Record<string, unknown> {
  const input = record(body);
  if (
    Object.keys(input).some((key) => !keys.includes(key)) ||
    typeof input.requestId !== 'string' ||
    !uuid.test(input.requestId)
  )
    throw new HttpError(400, 'InvalidControlRequest', 'Use a UUID requestId and only the supported fields.');
  return input;
}
export function bodyJson(request: IncomingMessage): Promise<unknown> {
  if (request.headers['content-type'] !== 'application/json')
    throw new HttpError(415, 'JsonRequired', 'Control requests require application/json.');
  if (Number(request.headers['content-length'] ?? 0) > 8192)
    throw new HttpError(413, 'BodyLimit', 'Control request is too large.');
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      clearTimeout(timer);
      request.off('data', data);
      request.off('end', end);
      request.off('aborted', aborted);
      request.off('error', aborted);
    };
    const failure = (error: HttpError) => {
      cleanup();
      request.resume();
      reject(error);
    };
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > 8192) failure(new HttpError(413, 'BodyLimit', 'Control request is too large.'));
      else chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'InvalidJson', 'Control request must contain valid JSON.'));
      }
    };
    const aborted = () => failure(new HttpError(400, 'RequestAborted', 'Control request was interrupted.'));
    const timer = setTimeout(() => failure(new HttpError(408, 'BodyTimeout', 'Control request timed out.')), 10000);
    timer.unref();
    request.on('data', data).once('end', end).once('aborted', aborted).once('error', aborted);
  });
}
/** Tracks CLI launchers only. Workspace and Temporal remain the scan execution authority. */
export class ScanControls {
  readonly csrfToken = randomBytes(32).toString('hex');
  private readonly live = new Map<string, StoredOperation>();
  private readonly temporal: TemporalReader;
  private readonly launch: (command: LaunchCommand) => ChildProcess;
  private readonly directory: string;
  private readonly readiness: NonNullable<ControlDependencies['readiness']>;
  private readonly targetCheck: NonNullable<ControlDependencies['targetCheck']>;
  readonly capabilities: ControlCapabilities;
  constructor(
    private config: DashboardConfig,
    dependencies: ControlDependencies = {},
  ) {
    const platform = dependencies.platform ?? process.platform;
    const uid = dependencies.uid ?? process.geteuid?.();
    const reason =
      platform === 'win32'
        ? 'WSL2 runner is not configured. Connect this Windows Dashboard to an authenticated runner inside WSL2.'
        : uid === 0 || (dependencies.sudo ?? Boolean(process.env.SUDO_USER))
          ? 'Astra CLI must run as a regular user, without sudo.'
          : !fs.existsSync(path.join(repositoryRoot, 'apps/cli/dist/index.mjs'))
            ? 'Build Astra CLI before starting scans.'
            : null;
    this.capabilities = {
      csrfToken: this.csrfToken,
      available: reason === null,
      reason,
      repositoryRoots: config.control?.repositoryRoots ?? [],
      workspaceRoot: config.workspaceRoot,
      runtime: platform,
    };
    this.readiness = dependencies.readiness ?? (() => dashboardRuntimeReadiness(path.join(repositoryRoot, '.env')));
    this.targetCheck = dependencies.targetCheck ?? ((target) => checkTargetPolicy(target, config.allowedPrivateHosts));
    // Controller records must not be writable through the scan worker's workspace mount.
    this.directory =
      config.control?.stateDirectory ??
      path.join(repositoryRoot, '.astra-dashboard', digest(config.workspaceRoot).slice(0, 16));
    if (contained(config.workspaceRoot, this.directory))
      throw new Error('Dashboard control state must be outside the worker workspace mount.');
    this.temporal = dependencies.temporal ?? readTemporal;
    this.launch =
      dependencies.launch ??
      ((command) =>
        spawn(command.executable, command.args, {
          cwd: command.cwd,
          env: command.env,
          shell: false,
          windowsHide: true,
          stdio: 'ignore',
        }));
  }
  async getCapabilities(): Promise<ControlCapabilities> {
    const issues = this.capabilities.reason
      ? [{ code: 'RuntimeUnavailable', message: this.capabilities.reason }]
      : await this.readiness();
    if (!this.capabilities.reason) {
      for (const root of [this.config.workspaceRoot, this.directory]) {
        try {
          let current = root;
          while (!fs.existsSync(current)) {
            const parent = path.dirname(current);
            if (parent === current) throw new Error('missing');
            current = parent;
          }
          if (fs.lstatSync(current).isSymbolicLink() || !fs.statSync(current).isDirectory()) throw new Error('unsafe');
          fs.accessSync(current, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
        } catch {
          issues.push({
            code: 'StorageUnavailable',
            message: 'Runner workspace or control storage is inaccessible or unsafe.',
          });
        }
      }
    }
    return {
      ...this.capabilities,
      available: issues.length === 0,
      stopAvailable: issues.every((issue) =>
        ['ModelCredentialsUnavailable', 'ModelConfigurationInvalid'].includes(issue.code),
      ),
      reason: issues[0]?.message ?? null,
      issues,
    };
  }
  private ensureDirectory(): void {
    fs.mkdirSync(this.directory, { mode: 0o700, recursive: true });
    this.assertDirectory();
    if (fs.existsSync(this.config.workspaceRoot) && fs.lstatSync(this.config.workspaceRoot).isSymbolicLink())
      throw new HttpError(403, 'UnsafeLink', 'Workspace links are blocked.');
  }
  private assertDirectory(): void {
    const stat = fs.lstatSync(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new HttpError(403, 'UnsafeLink', 'Control state links are blocked.');
  }
  private stored(id: string): StoredOperation {
    if (!uuid.test(id)) throw new HttpError(400, 'InvalidOperation', 'Invalid operation identifier.');
    const current = this.live.get(id);
    if (current) return current;
    let value: StoredOperation;
    try {
      value = JSON.parse(safeRead(this.directory, `${id}.json`, 8192).toString());
    } catch (error) {
      if (record(error).code === 'ENOENT')
        throw new HttpError(404, 'OperationNotFound', 'Control operation does not exist.');
      throw new HttpError(503, 'ControlStateUnavailable', 'Control state cannot be read safely.');
    }
    if (
      value.id !== id ||
      !['start', 'stop'].includes(value.kind) ||
      !['starting', 'running', 'exited', 'failed', 'unknown'].includes(value.processState) ||
      !/^[a-f0-9]{64}$/.test(value.fingerprint) ||
      !/^[a-f0-9]{64}$/.test(value.requestFingerprint) ||
      typeof value.requestedAt !== 'string' ||
      !Number.isFinite(Date.parse(value.requestedAt)) ||
      typeof value.updatedAt !== 'string' ||
      !Number.isFinite(Date.parse(value.updatedAt)) ||
      !(value.pid === null || (Number.isInteger(value.pid) && (value.pid ?? 0) > 0)) ||
      !(value.exitCode === null || Number.isInteger(value.exitCode)) ||
      !(value.signal === null || /^SIG[A-Z0-9]+$/.test(value.signal)) ||
      !(value.error === null || Object.hasOwn(messages, value.error?.code ?? ''))
    )
      throw new HttpError(503, 'ControlStateUnavailable', 'Control state has an invalid schema.');
    identifier(value.workspace);
    if (value.processState === 'starting' || value.processState === 'running') {
      value.processState = 'unknown';
      value.error = { code: 'ObservationLost', message: messages.ObservationLost };
    }
    return value;
  }
  list(): ControlOperation[] {
    if (!fs.existsSync(this.directory)) return [];
    this.assertDirectory();
    const names = fs
      .readdirSync(this.directory)
      .filter((name) => uuid.test(name.replace(/\.json$/, '')) && name.endsWith('.json'));
    if (names.length > 200)
      throw new HttpError(503, 'ControlHistoryLimit', 'Control history exceeds the supported limit.');
    return names
      .map((name) => publicOperation(this.stored(name.slice(0, -5))))
      .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
  }
  get(id: string): ControlOperation {
    return publicOperation(this.stored(id));
  }
  private persist(value: StoredOperation): void {
    const temporary = `${value.id}.json.tmp-${randomUUID()}`;
    const target = path.join(this.directory, `${value.id}.json`);
    this.assertDirectory();
    const descriptor = fs.openSync(path.join(this.directory, temporary), 'wx', 0o600);
    try {
      fs.writeFileSync(descriptor, JSON.stringify(value));
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(path.join(this.directory, temporary), target);
  }
  private async closed(workspace: string): Promise<boolean> {
    try {
      const ws = readWorkspace(this.config.workspaceRoot, workspace);
      if (!ws.workflowId) return false;
      const observed = await this.temporal(ws.workflowId);
      return observed.health === 'fresh' && observed.execution !== null && terminal.has(observed.execution.status);
    } catch {
      return false;
    }
  }
  private publish(value: StoredOperation): void {
    value.updatedAt = new Date().toISOString();
    try {
      this.persist(value);
    } catch {
      value.error = { code: 'JournalUnavailable', message: messages.JournalUnavailable };
    }
  }
  async submit(kind: 'start' | 'stop', body: unknown, workspace?: string): Promise<ControlOperation> {
    const input = validateBody(
      body,
      kind === 'start' ? ['requestId', 'url', 'repository', 'authorized'] : ['requestId', 'confirmed'],
    );
    if ((kind === 'start' ? input.authorized : input.confirmed) !== true)
      throw new HttpError(
        400,
        'ConfirmationRequired',
        kind === 'start' ? 'Confirm that you are authorized to test this target.' : 'Confirm stopping this scan.',
      );
    const start =
      kind === 'start'
        ? {
            target: validateTarget(input.url),
            repository: validateRepository(input.repository, this.capabilities.repositoryRoots),
          }
        : null;
    const stopWorkspace = kind === 'stop' ? identifier(workspace ?? '') : null;
    if (stopWorkspace) readWorkspace(this.config.workspaceRoot, stopWorkspace);
    const fingerprint = digest(start ? JSON.stringify([start.target.href, start.repository]) : `stop:${stopWorkspace}`);
    const requestFingerprint = digest(JSON.stringify([kind, fingerprint]));
    const id = input.requestId as string;
    if (!this.capabilities.available)
      throw new HttpError(503, 'ControlUnavailable', this.capabilities.reason ?? 'Controls are unavailable.');
    const capabilities = await this.getCapabilities();
    if (!(kind === 'stop' ? capabilities.stopAvailable : capabilities.available))
      throw new HttpError(503, 'ControlUnavailable', capabilities.reason ?? 'Controls are unavailable.');
    if (start) {
      if (!this.capabilities.repositoryRoots.includes(start.repository))
        throw new HttpError(403, 'RepositoryBlocked', 'Choose a configured source directory.');
      await this.targetCheck(start.target);
    }
    this.ensureDirectory();
    const mutex = path.join(this.directory, 'mutation.lock');
    let descriptor: number;
    try {
      descriptor = fs.openSync(mutex, 'wx', 0o600);
    } catch {
      throw new HttpError(
        409,
        'ControlBusy',
        'Another control request is in progress. Retry with the same requestId.',
        true,
      );
    }
    try {
      const existing = this.list();
      if (existing.some((operation) => operation.id === id)) {
        const previous = this.stored(id);
        if (previous.requestFingerprint !== requestFingerprint)
          throw new HttpError(409, 'IdempotencyConflict', 'This requestId was used for a different request.');
        return publicOperation(previous);
      }
      if (existing.length >= 200)
        throw new HttpError(
          429,
          'ControlHistoryLimit',
          'Control history is full. Archive it while Dashboard is stopped.',
        );
      for (const operation of existing) {
        const previous = this.stored(operation.id);
        if (previous.fingerprint !== fingerprint) continue;
        const noWorkspace = !fs.existsSync(path.join(this.config.workspaceRoot, previous.workspace));
        const safelyFailed = previous.processState === 'failed' && noWorkspace;
        const finishedStop = kind === 'stop' && ['failed', 'exited'].includes(previous.processState);
        if (!safelyFailed && !finishedStop && !(await this.closed(previous.workspace)))
          throw new HttpError(
            409,
            'ScanAlreadyActive',
            `Existing request for workspace ${previous.workspace} is active or unverified. Open its detail before retrying.`,
          );
      }
      if (start) {
        for (const name of listWorkspaceNames(this.config.workspaceRoot)) {
          const ws = readWorkspace(this.config.workspaceRoot, name);
          if (ws.target === safeUrl(start.target.href) && !(await this.closed(name)))
            throw new HttpError(
              409,
              'ScanAlreadyActive',
              `Workspace ${name} already targets this URL and is not confirmed closed.`,
            );
        }
      }
      let active = 0;
      for (const operation of existing.filter(
        (item) => item.kind === kind && ['starting', 'running', 'unknown'].includes(item.processState),
      )) {
        if (operation.processState !== 'unknown' || !(await this.closed(operation.workspace))) active++;
      }
      if (active >= 4)
        throw new HttpError(
          429,
          'LauncherLimit',
          'Too many active or unverified CLI launchers. Verify their status first.',
        );
      const name = identifier(
        stopWorkspace ??
          (start
            ? `scan-${start.target.hostname.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 48)}_dashboard-${randomUUID()}`
            : ''),
      );
      if (kind === 'start' && fs.existsSync(path.join(this.config.workspaceRoot, name)))
        throw new HttpError(409, 'WorkspaceExists', 'Generated workspace already exists. Retry with a new requestId.');
      const now = new Date().toISOString();
      const operation: StoredOperation = {
        id,
        kind,
        workspace: name,
        requestedAt: now,
        updatedAt: now,
        processState: 'starting',
        pid: null,
        exitCode: null,
        signal: null,
        error: null,
        fingerprint,
        requestFingerprint,
      };
      this.persist(operation);
      this.live.set(id, operation);
      const command: LaunchCommand = {
        executable: process.execPath,
        args: start
          ? [
              path.join(repositoryRoot, 'astra'),
              'start',
              '--url',
              start.target.href,
              '--repo',
              start.repository,
              '--workspace',
              name,
            ]
          : [path.join(repositoryRoot, 'astra'), 'stop', name, '--yes'],
        cwd: repositoryRoot,
        env: { ...process.env, ASTRA_WORKSPACES_DIR: this.config.workspaceRoot },
      };
      try {
        const child = this.launch(command);
        operation.pid = child.pid ?? null;
        child.once('spawn', () => {
          operation.processState = 'running';
          this.publish(operation);
        });
        child.once('error', () => {
          operation.processState = 'failed';
          operation.error = { code: 'LauncherSpawnFailed', message: messages.LauncherSpawnFailed };
          this.publish(operation);
        });
        child.once('close', (code: number | null, signal: string | null) => {
          operation.exitCode = code;
          operation.signal = signal;
          operation.processState = code === 0 ? 'exited' : 'failed';
          if (!operation.error && code !== 0)
            operation.error = { code: 'LauncherFailed', message: messages.LauncherFailed };
          this.publish(operation);
        });
        this.publish(operation);
      } catch {
        operation.processState = 'failed';
        operation.error = { code: 'LauncherSpawnFailed', message: messages.LauncherSpawnFailed };
        this.publish(operation);
      }
      return publicOperation(operation);
    } finally {
      fs.closeSync(descriptor);
      fs.unlinkSync(mutex);
    }
  }
  async route(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    const stop = /^\/api\/scans\/([^/]+)\/stop$/.exec(url.pathname);
    if (
      !url.pathname.startsWith('/api/control/') &&
      !stop &&
      !(url.pathname === '/api/scans' && request.method === 'POST')
    )
      return false;
    if (url.search) throw new HttpError(400, 'InvalidQuery', 'Control routes do not accept query parameters.');
    if (request.method === 'GET') {
      if (url.pathname === '/api/control/capabilities')
        sendJson(response, 200, { data: await this.getCapabilities(), meta: metadata() });
      else if (url.pathname === '/api/control/operations')
        sendJson(response, 200, { data: this.list(), meta: metadata() });
      else if (/^\/api\/control\/operations\/[^/]+$/.test(url.pathname))
        sendJson(response, 200, { data: this.get(url.pathname.split('/').at(-1) ?? ''), meta: metadata() });
      else throw new HttpError(404, 'RouteNotFound', 'Control route does not exist.');
      return true;
    }
    if (request.method !== 'POST')
      throw new HttpError(405, 'MethodBlocked', 'Control routes support GET and POST only.');
    const supplied = request.headers['x-astra-control'];
    if (
      request.headers.origin !== `http://${request.headers.host}` ||
      typeof supplied !== 'string' ||
      !/^[a-f0-9]{64}$/.test(supplied) ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(this.csrfToken))
    )
      throw new HttpError(
        403,
        'ControlForbidden',
        'Control requests require the same origin and dashboard control token.',
      );
    if (!stop && url.pathname !== '/api/scans')
      throw new HttpError(404, 'RouteNotFound', 'Control route does not exist.');
    const operation = await this.submit(
      stop ? 'stop' : 'start',
      await bodyJson(request),
      stop ? decodeURIComponent(stop[1] ?? '') : undefined,
    );
    sendJson(response, 202, { data: operation, meta: metadata() });
    return true;
  }
}
