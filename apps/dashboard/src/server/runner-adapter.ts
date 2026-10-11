import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ControlCapabilities } from '../contracts.js';
import type { DashboardConfig } from './config.js';
import { bodyJson } from './control.js';
import { sendJson } from './routes.js';
import { HttpError } from './security.js';
import { metadata } from './snapshot.js';

export function runnerAuthenticated(request: IncomingMessage, token: string): boolean {
  const supplied = request.headers.authorization;
  return (
    typeof supplied === 'string' &&
    /^Bearer [a-f0-9]{64}$/.test(supplied) &&
    timingSafeEqual(Buffer.from(supplied.slice(7)), Buffer.from(token))
  );
}
/** This adapter never spawns a CLI, translates a path, or owns an execution. */
export class RunnerAdapter {
  readonly csrfToken = randomBytes(32).toString('hex');
  constructor(private runner: NonNullable<DashboardConfig['remoteRunner']>) {}
  private async request(route: string, body?: unknown, csrf?: string): Promise<Response> {
    try {
      return await fetch(new URL(route, this.runner.url), {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          authorization: `Bearer ${this.runner.token}`,
          ...(body !== undefined
            ? {
                origin: new URL(this.runner.url).origin,
                'content-type': 'application/json',
                'x-astra-control': csrf ?? '',
              }
            : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(12000),
      });
    } catch {
      throw new HttpError(
        503,
        'RunnerUnavailable',
        'Cannot connect to the WSL2 runner. Check the service, its port and WSL localhost forwarding.',
        true,
      );
    }
  }
  private async capabilities(): Promise<ControlCapabilities> {
    const response = await this.request('/api/control/capabilities');
    if (response.status === 401 || response.status === 403)
      throw new HttpError(
        503,
        'RunnerAuthenticationFailed',
        'Runner authentication failed. Check the server-side token files.',
      );
    if (!response.ok) throw new HttpError(503, 'RunnerUnavailable', 'Runner readiness could not be read.');
    const result = (await response.json()) as { data?: ControlCapabilities };
    if (!result.data || result.data.runtime !== 'linux' || !/^[a-f0-9]{64}$/.test(result.data.csrfToken))
      throw new HttpError(
        503,
        'RunnerProtocolInvalid',
        'The configured service is not a compatible Linux Astra runner.',
      );
    const data = result.data;
    return {
      csrfToken: data.csrfToken,
      available: data.available,
      stopAvailable: data.stopAvailable ?? data.available,
      reason: data.reason,
      repositoryRoots: data.repositoryRoots,
      workspaceRoot: data.workspaceRoot,
      runtime: 'linux',
      ...(data.issues ? { issues: data.issues } : {}),
    };
  }
  async route(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    if (url.pathname === '/api/control/capabilities' && request.method === 'GET') {
      if (url.search) throw new HttpError(400, 'InvalidQuery', 'Control routes do not accept query parameters.');
      let capabilities: ControlCapabilities;
      try {
        capabilities = { ...(await this.capabilities()), csrfToken: this.csrfToken };
      } catch (error) {
        const failure =
          error instanceof HttpError
            ? error
            : new HttpError(503, 'RunnerProtocolInvalid', 'Runner readiness response is invalid.');
        capabilities = {
          csrfToken: this.csrfToken,
          available: false,
          reason: failure.message,
          repositoryRoots: [],
          workspaceRoot: '',
          runtime: 'wsl2-unavailable',
          issues: [{ code: failure.code, message: failure.message }],
        };
      }
      sendJson(response, 200, { data: capabilities, meta: metadata() });
      return;
    }
    if (!/^\/api\/(?:scans(?:\/|$)|control\/operations(?:\/|$))/.test(url.pathname))
      throw new HttpError(404, 'RouteNotFound', 'API route does not exist.');
    let upstream: Response;
    if (request.method === 'POST') {
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
      if (url.search || !(url.pathname === '/api/scans' || /^\/api\/scans\/[^/]+\/stop$/.test(url.pathname)))
        throw new HttpError(404, 'RouteNotFound', 'Unsupported control route.');
      const body = await bodyJson(request);
      const capabilities = await this.capabilities();
      upstream = await this.request(url.pathname, body, capabilities.csrfToken);
    } else if (request.method === 'GET') upstream = await this.request(url.pathname + url.search);
    else throw new HttpError(405, 'MethodBlocked', 'Only GET and POST are supported.');
    // Forward only application payloads. Never forward authentication or upstream cookies.
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = upstream.body?.getReader();
    try {
      if (reader)
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 16 * 1024 * 1024) {
            await reader.cancel();
            throw new HttpError(503, 'RunnerResponseLimit', 'Runner response exceeded the dashboard limit.');
          }
          chunks.push(chunk.value);
        }
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(503, 'RunnerUnavailable', 'Runner response was interrupted.', true);
    }
    const payload = Buffer.concat(chunks);
    const headers: Record<string, string> = {
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    };
    for (const key of ['content-disposition', 'x-content-sha256']) {
      const value = upstream.headers.get(key);
      if (value) headers[key] = value;
    }
    response.writeHead(upstream.status, headers);
    response.end(payload);
  }
}
