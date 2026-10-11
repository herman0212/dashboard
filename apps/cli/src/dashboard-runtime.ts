/** Host readiness only; the normal CLI still performs all launch/preflight checks. */
import { execFile } from 'node:child_process';
import { loadEnv, validateCredentials } from './env.js';
import { setMode } from './mode.js';

export async function dashboardRuntimeReadiness(
  environmentFile = '.env',
): Promise<{ code: string; message: string }[]> {
  const issues: { code: string; message: string }[] = [];
  setMode('local');
  try {
    loadEnv(environmentFile);
    if (!validateCredentials().valid)
      issues.push({
        code: 'ModelCredentialsUnavailable',
        message: 'Configure a valid model and its credentials in the runner environment or Astra .env.',
      });
  } catch {
    issues.push({ code: 'ModelConfigurationInvalid', message: 'The runner model configuration could not be loaded.' });
  }
  const docker = await new Promise<boolean>((resolve) => {
    execFile(
      'docker',
      ['info', '--format', '{{.ServerVersion}}'],
      { timeout: 5000, maxBuffer: 65536, windowsHide: true },
      (error, output) => resolve(!error && Boolean(output.trim())),
    );
  });
  if (!docker)
    issues.push({
      code: 'DockerUnavailable',
      message: 'Docker is not installed, accessible or running inside the runner environment.',
    });
  return issues;
}
