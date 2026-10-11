import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
export interface DashboardConfig {
  workspaceRoot: string;
  webRoot: string;
  port: number;
  maxConcurrent: number;
  runnerToken?: string;
  remoteRunner?: { url: string; token: string };
  allowedPrivateHosts?: string[];
  control?: { repositoryRoots: string[]; stateDirectory?: string };
}
export function configuration(): DashboardConfig {
  const settingsFile = process.env.ASTRA_DASHBOARD_SETTINGS_FILE;
  const settings: { repositoryRoots?: string[]; allowedPrivateHosts?: string[] } = settingsFile
    ? JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
    : {};
  const port = Number(process.env.ASTRA_DASHBOARD_PORT ?? 4310);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid ASTRA_DASHBOARD_PORT.');
  const connectionFile = path.join(repositoryRoot, '.astra-dashboard/runner-connection.json');
  const connection: { url?: string; tokenFile?: string } = fs.existsSync(connectionFile)
    ? JSON.parse(fs.readFileSync(connectionFile, 'utf8'))
    : {};
  const tokenFile = process.env.ASTRA_DASHBOARD_RUNNER_TOKEN_FILE ?? connection.tokenFile;
  const token = tokenFile ? fs.readFileSync(tokenFile, 'utf8').trim() : undefined;
  if (token !== undefined && !/^[a-f0-9]{64}$/.test(token))
    throw new Error('Runner token file must contain a 32-byte hex token.');
  const remote = process.env.ASTRA_DASHBOARD_RUNNER_URL ?? connection.url;
  if (remote) {
    const url = new URL(remote);
    if (
      url.protocol !== 'http:' ||
      url.hostname !== '127.0.0.1' ||
      !url.port ||
      Number(url.port) < 1024 ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      url.username ||
      url.password ||
      !token ||
      Number(url.port) === port
    )
      throw new Error('Runner URL must be a separate http://127.0.0.1:PORT with a token file.');
  }
  if (!remote && token && process.platform !== 'linux')
    throw new Error('The authenticated runner must run on Linux/WSL2.');
  const privateHosts: unknown = JSON.parse(
    process.env.ASTRA_DASHBOARD_ALLOWED_PRIVATE_HOSTS ?? JSON.stringify(settings.allowedPrivateHosts ?? []),
  );
  if (
    !Array.isArray(privateHosts) ||
    privateHosts.length > 128 ||
    privateHosts.some((v) => typeof v !== 'string' || v.length > 253 || !/^[a-zA-Z0-9.:[\]-]+$/.test(v))
  )
    throw new Error('Invalid private host allowlist.');
  const roots: unknown = JSON.parse(
    process.env.ASTRA_DASHBOARD_REPO_ROOTS ?? JSON.stringify(settings.repositoryRoots ?? [repositoryRoot]),
  );
  if (!Array.isArray(roots) || roots.length < 1 || roots.length > 16)
    throw new Error('ASTRA_DASHBOARD_REPO_ROOTS must be a JSON array of 1–16 absolute directories.');
  const repositoryRoots = roots.map((root: unknown) => {
    if (typeof root !== 'string' || !path.isAbsolute(root) || !fs.statSync(root).isDirectory())
      throw new Error('Repository roots must be existing absolute directories.');
    return fs.realpathSync(root);
  });
  return {
    workspaceRoot: path.resolve(process.env.ASTRA_WORKSPACES_DIR ?? path.join(repositoryRoot, 'workspaces')),
    webRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web'),
    port,
    maxConcurrent: 8,
    ...(remote && token ? { remoteRunner: { url: remote, token } } : token ? { runnerToken: token } : {}),
    allowedPrivateHosts: privateHosts as string[],
    control: {
      repositoryRoots,
      ...(process.env.ASTRA_DASHBOARD_CONTROL_DIR && {
        stateDirectory: path.resolve(process.env.ASTRA_DASHBOARD_CONTROL_DIR),
      }),
    },
  };
}
