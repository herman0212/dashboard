import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public retryable = false,
  ) {
    super(message);
  }
}
export const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
export function identifier(value: string): string {
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,179}$/.test(value) ||
    value.includes('..') ||
    /[. ]$/.test(value) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)
  ) {
    throw new HttpError(400, 'InvalidIdentifier', 'Invalid workspace or artifact identifier.');
  }
  return value;
}
export function contained(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}
/** Reject every link/junction from the trusted root to the requested server-owned slot. */
export function safePath(root: string, relativePath: string): string {
  if (
    path.isAbsolute(relativePath) ||
    relativePath.includes('\0') ||
    relativePath.split(/[\\/]/).some((p) => p === '..' || p === '.' || p === '') ||
    relativePath.includes(':')
  ) {
    throw new HttpError(400, 'UnsafePath', 'Invalid artifact path.');
  }
  const absoluteRoot = path.resolve(root);
  const target = path.resolve(absoluteRoot, relativePath);
  if (!contained(absoluteRoot, target)) throw new HttpError(400, 'UnsafePath', 'Path is outside the workspace.');
  const rootStat = fs.lstatSync(absoluteRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory())
    throw new HttpError(403, 'UnsafeLink', 'Workspace links are blocked.');
  const realRoot = fs.realpathSync(absoluteRoot);
  let current = absoluteRoot;
  for (const component of path.relative(absoluteRoot, target).split(path.sep)) {
    current = path.join(current, component);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new HttpError(403, 'UnsafeLink', 'Workspace links are blocked.');
    if (!contained(realRoot, fs.realpathSync(current)))
      throw new HttpError(403, 'OutsideRoot', 'Artifact is outside the workspace.');
  }
  return target;
}
export function missing(error: unknown): boolean {
  return record(error).code === 'ENOENT';
}
export function safeRead(root: string, relativePath: string, maxBytes = 10 * 1024 * 1024): Buffer {
  const target = safePath(root, relativePath);
  const before = fs.lstatSync(target);
  if (!before.isFile() || before.nlink > 1)
    throw new HttpError(403, 'UnsafeFile', 'Only regular, unlinked artifact files are readable.');
  if (before.size > maxBytes) throw new HttpError(503, 'SizeLimit', 'Artifact exceeds the read limit.');
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(fd);
    safePath(root, relativePath);
    if (opened.ino !== before.ino || opened.dev !== before.dev || opened.size > maxBytes)
      throw new HttpError(409, 'ArtifactChanged', 'Artifact changed while being read.', true);
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    const after = fs.fstatSync(fd);
    if (offset !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs)
      throw new HttpError(409, 'ArtifactChanged', 'Artifact changed while being read.', true);
    safePath(root, relativePath);
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}
export function optionalRead(root: string, paths: string[], maxBytes?: number): { bytes: Buffer; slot: string } | null {
  for (const slot of paths) {
    try {
      return { bytes: safeRead(root, slot, maxBytes), slot };
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
  return null;
}
export function safeUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return sanitizeText(url.toString(), 2000);
  } catch {
    return null;
  }
}
/** Free text is a sanitized projection; raw prompts, tool arguments and unknown log lines never enter here. */
export function sanitizeText(value: unknown, limit = 4000): string | null {
  if (typeof value !== 'string') return null;
  return Array.from(value.slice(0, limit))
    .filter((character) => {
      const code = character.charCodeAt(0);
      return (code >= 32 && code !== 127) || code === 9 || code === 10 || code === 13;
    })
    .join('')
    .replace(/-----BEGIN [^-]*(?:PRIVATE KEY|CERTIFICATE)-----[\s\S]*?(?:-----END [^-]+-----|$)/gi, '[REDACTED]')
    .replace(
      /(?:set-cookie|cookies?|authorization|proxy-authorization|x-api-key)["']?\s*[:=][^\r\n]*/gi,
      '[REDACTED header]',
    )
    .replace(
      /(?:raw[_-]?prompt|system[_-]?prompt|prompt|auth[_-]?state|tool[_-]?arguments)["']?\s*[:=][\s\S]*/gi,
      '[REDACTED private payload]',
    )
    .replace(
      /(?:[a-zA-Z0-9_-]*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret|sessionid|session[_-]?token|auth[_-]?state)[a-zA-Z0-9_-]*|token)\s*["']?\s*[:=]\s*["']?[^\s,;\r\n"'}]+/gi,
      '[REDACTED credential]',
    )
    .replace(/\b(?:Bearer|Basic)\s+[a-zA-Z0-9._~+/=-]+/gi, '[REDACTED authorization]')
    .replace(
      /\b(?:sk-[a-zA-Z0-9_-]{8,}|gh[pousr]_[a-zA-Z0-9]{10,}|github_pat_[a-zA-Z0-9_]{10,}|AKIA[A-Z0-9]{16}|AIza[a-zA-Z0-9_-]{20,})\b/g,
      '[REDACTED key]',
    )
    .replace(/\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g, '[REDACTED token]')
    .replace(/https?:\/\/[^\s<>"'`]+/gi, (raw) => {
      try {
        const url = new URL(raw);
        url.username = '';
        url.password = '';
        url.search = '';
        url.hash = '';
        return url.toString();
      } catch {
        return '[REDACTED URL]';
      }
    });
}
export function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
export function iso(value: unknown): string | null {
  const millis = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}
