import fs from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDashboardConnection } from '@keygraph/astra/dashboard-read';
import { configuration, type DashboardConfig } from './config.js';
import { type ControlDependencies, ScanControls } from './control.js';
import { apiError, apiRoutes } from './routes.js';
import { RunnerAdapter, runnerAuthenticated } from './runner-adapter.js';
import { HttpError, safeRead } from './security.js';
import type { TemporalReader } from './snapshot.js';
export function dashboardServer(
  config: DashboardConfig,
  temporalReader?: TemporalReader,
  controlDependencies?: ControlDependencies,
) {
  const route = apiRoutes(config, temporalReader);
  const adapter = config.remoteRunner ? new RunnerAdapter(config.remoteRunner) : null;
  const controls = !adapter && config.control ? new ScanControls(config, controlDependencies) : null;
  let active = 0;
  const server = createServer(async (req, res) => {
    let counted = false;
    try {
      if (active >= config.maxConcurrent)
        throw new HttpError(503, 'ConcurrencyLimit', 'Dashboard is busy. Retry shortly.', true);
      active++;
      counted = true;
      if ((req.url?.length ?? 0) > 4096) throw new HttpError(400, 'RequestLimit', 'Request is too large.');
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : config.port;
      const host = req.headers.host;
      const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!host || !allowedHosts.includes(host))
        throw new HttpError(403, 'HostBlocked', 'Only the localhost dashboard origin is allowed.');
      const origin = `http://${host}`;
      if (
        (req.headers.origin && req.headers.origin !== origin) ||
        (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(String(req.headers['sec-fetch-site'])))
      )
        throw new HttpError(403, 'OriginBlocked', 'Cross-origin access is blocked.');
      const url = new URL(req.url ?? '/', origin);
      if (url.origin !== origin) throw new HttpError(403, 'OriginBlocked', 'Cross-origin access is blocked.');
      // Check encoded paths before URL normalization hides traversal segments.
      let rawPath: string;
      try {
        rawPath = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
      } catch {
        throw new HttpError(400, 'InvalidEncoding', 'Invalid URL encoding.');
      }
      if (rawPath.includes('\\') || rawPath.split('/').some((v) => v === '..' || v === '.') || rawPath.includes('\0'))
        throw new HttpError(400, 'UnsafePath', 'Path traversal is blocked.');
      if (url.pathname.startsWith('/api/')) {
        if (config.runnerToken && !runnerAuthenticated(req, config.runnerToken))
          throw new HttpError(401, 'RunnerAuthenticationRequired', 'Runner authentication is required.');
        if (adapter) {
          await adapter.route(req, res, url);
          return;
        }
        if (controls && (await controls.route(req, res, url))) return;
        await route(req, res, url);
        return;
      }
      if (config.runnerToken)
        throw new HttpError(404, 'RunnerApiOnly', 'Runner serves authenticated API requests only.');
      if (req.method !== 'GET') throw new HttpError(405, 'ReadOnly', 'Dashboard only supports GET.');
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (file !== 'index.html' && !/^assets\/[a-zA-Z0-9_.-]+\.(?:js|css|svg)$/.test(file))
        throw new HttpError(404, 'FileNotFound', 'Frontend file does not exist.');
      let bytes: Buffer;
      try {
        bytes = safeRead(config.webRoot, file);
      } catch {
        throw new HttpError(404, 'FileNotFound', 'Build the dashboard frontend first.');
      }
      const mime = file.endsWith('.js')
        ? 'text/javascript'
        : file.endsWith('.css')
          ? 'text/css'
          : file.endsWith('.svg')
            ? 'image/svg+xml'
            : 'text/html';
      res.writeHead(200, {
        'content-type': `${mime}; charset=utf-8`,
        'cache-control': 'no-store',
        'content-security-policy':
          "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      });
      res.end(bytes);
    } catch (error) {
      if (!res.headersSent) apiError(res, error);
      else res.end();
    } finally {
      if (counted) active = Math.max(0, active - 1);
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 50;
  return server;
}
const entry = process.argv[1];
if (entry && path.resolve(entry) === fileURLToPath(import.meta.url)) {
  const config = configuration();
  if (!fs.existsSync(path.join(config.webRoot, 'index.html')))
    throw new Error('Run pnpm dashboard:build before starting.');
  const server = dashboardServer(config);
  server.listen(config.port, '127.0.0.1', () => {
    process.stdout.write(`Astra Dashboard: http://127.0.0.1:${config.port}\n`);
  });
  const close = () => {
    server.close();
    void closeDashboardConnection().finally(() => {
      process.exitCode = 0;
    });
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}
