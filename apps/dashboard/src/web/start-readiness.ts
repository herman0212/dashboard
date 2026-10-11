import type { ControlCapabilities } from '../contracts.js';
export function startScanReady(
  config: ControlCapabilities | null | undefined,
  url: string,
  repository: string,
  authorized: boolean,
  busy: boolean,
  stale: boolean,
): boolean {
  if (!config?.available || !authorized || busy || stale || !config.repositoryRoots.includes(repository)) return false;
  try {
    const target = new URL(url);
    return (
      /^https?:\/\//i.test(url) &&
      url.length <= 2048 &&
      !/\s/.test(url) &&
      !Array.from(url).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) &&
      ['http:', 'https:'].includes(target.protocol) &&
      Boolean(target.hostname) &&
      !target.username &&
      !target.password &&
      !target.hash
    );
  } catch {
    return false;
  }
}
