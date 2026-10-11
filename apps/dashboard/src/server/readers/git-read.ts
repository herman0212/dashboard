import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';
import { HttpError, safePath, safeRead } from '../security.js';

const execute = promisify(execFile);
/** Refuse external gitdirs, includes and executable Git config. Only blob reads are allowed. */
export function assertDeliverablesGit(workspaceRoot: string, deliverablesSlot: string): string {
  const dir = safePath(workspaceRoot, deliverablesSlot);
  const git = safePath(workspaceRoot, `${deliverablesSlot}/.git`);
  if (!fs.statSync(git).isDirectory())
    throw new HttpError(503, 'GitProofUnavailable', 'Deliverable Git proof is unavailable.');
  const config = safeRead(workspaceRoot, `${deliverablesSlot}/.git/config`, 1024 * 1024).toString('utf8');
  if (
    /^\s*\[(?:include|includeIf|filter|alias)\b|^\s*(?:fsmonitor|sshCommand|pager|hooksPath|worktree)\s*=/im.test(
      config,
    )
  )
    throw new HttpError(403, 'UnsafeGitConfig', 'Deliverable Git configuration is blocked.');
  let count = 0;
  const walk = (relative: string) => {
    const directory = safePath(workspaceRoot, relative);
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      if (++count > 20000) throw new HttpError(503, 'GitReadLimit', 'Deliverable Git metadata exceeds the read limit.');
      const child = `${relative}/${item.name}`;
      safePath(workspaceRoot, child);
      if (item.isDirectory()) walk(child);
    }
  };
  walk(`${deliverablesSlot}/.git`);
  return dir;
}
export async function readGit(dir: string, args: string[]): Promise<string> {
  const result = await execute(
    'git',
    ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=', '-C', dir, ...args],
    {
      timeout: 5000,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
      },
    },
  );
  return result.stdout;
}
export function deliverablesSlot(workspaceRoot: string): string | null {
  for (const slot of ['.astra/deliverables', 'deliverables']) {
    try {
      if (fs.statSync(safePath(workspaceRoot, slot)).isDirectory()) return slot;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return null;
}
