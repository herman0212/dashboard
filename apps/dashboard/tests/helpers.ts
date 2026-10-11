import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PipelineState } from '@astra/worker/dashboard-contracts';
import type { DashboardExecution } from '@keygraph/astra/dashboard-read';
import type { DashboardConfig } from '../src/server/config.js';
export function fixture() {
  const parent = path.resolve(process.env.ASTRA_DASHBOARD_TEST_TMP ?? os.tmpdir());
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'astra-dashboard-test-'));
  const name = 'real-schema-test';
  const workspace = path.join(root, name);
  fs.mkdirSync(path.join(workspace, '.astra', 'deliverables'), { recursive: true });
  const session = {
    session: { id: name, originalWorkflowId: 'test-workflow', webUrl: 'https://example.test/?token=never-publish' },
    metrics: { agents: {}, runs: {} },
    durableScanState: {
      schema_version: 1,
      exploit: true,
      participating_classes: ['injection'],
      expected_agents: ['pre-recon', 'recon', 'injection-vuln', 'injection-exploit', 'report'],
    },
  };
  const save = () => fs.writeFileSync(path.join(workspace, '.astra/session.json'), JSON.stringify(session));
  save();
  const config: DashboardConfig = {
    workspaceRoot: root,
    webRoot: path.resolve('dist/web'),
    port: 4310,
    maxConcurrent: 8,
  };
  return {
    root,
    workspace,
    name,
    session,
    save,
    config,
    close: () => {
      const resolved = path.resolve(root);
      if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith('astra-dashboard-test-'))
        throw new Error('Unsafe test cleanup.');
      fs.rmSync(resolved, { recursive: true, force: true });
    },
  };
}
export function state(overrides: Partial<PipelineState> = {}): PipelineState {
  return {
    status: 'running',
    currentPhase: 'vulnerability-exploitation',
    currentAgent: 'pipelines',
    completedAgents: ['pre-recon', 'recon'],
    skippedAgents: [],
    expectedAgents: ['pre-recon', 'recon', 'injection-vuln', 'injection-exploit', 'report'],
    participatingClasses: ['injection'],
    failedPipelines: [],
    failedReconciliations: [],
    failedAgent: null,
    error: null,
    startTime: Date.now() - 1000,
    agentMetrics: {},
    operationalMetrics: {},
    operationalStages: {},
    agenticSast: { status: 'disabled' },
    nonFatalFailures: [],
    partialReasons: [],
    summary: null,
    ...overrides,
  };
}
export function execution(overrides: Partial<DashboardExecution> = {}): DashboardExecution {
  return {
    workflowId: 'test-workflow',
    runId: 'run-1',
    status: 'RUNNING',
    startedAt: Date.now() - 1000,
    closedAt: null,
    pending: [],
    progress: state(),
    progressSource: 'query',
    progressUnavailable: false,
    terminalFailure: false,
    ...overrides,
  };
}
export function git(dir: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=Dashboard Tests',
      '-c',
      'user.email=dashboard-test@example.test',
      '-c',
      'core.autocrlf=false',
      '-C',
      dir,
      ...args,
    ],
    { encoding: 'utf8', windowsHide: true },
  );
}
export function treeDigest(root: string): string {
  const entries: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) entries.push(`${path.relative(root, full)}:${fs.readFileSync(full).toString('base64')}`);
    }
  };
  walk(root);
  return JSON.stringify(entries);
}
