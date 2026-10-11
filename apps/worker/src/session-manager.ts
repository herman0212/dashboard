// Copyright (C) 2026 Keygraph, Inc.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation.

import { fs, path } from 'zx';

import type { ActivityLogger } from './types/activity-logger.js';
import type { AgentDefinition, AgentName, AgentValidator, PlaywrightSession, VulnType } from './types/index.js';

// Single source of truth for every agent the pipeline can run. Each entry:
//   - name / displayName: identity used in logs, metrics, and per-agent log filenames
//   - prerequisites: the agents this one conceptually depends on. This is documentation
//     of the intended dependency graph, not an executed check. Actual phase ordering and
//     concurrency are enforced by the explicit phase structure in the Temporal workflow.
//   - promptTemplate: the file under apps/worker/prompts/ (without extension) rendered for this agent
//   - deliverableFilename: the canonical filename AgentExecutionService and the
//     save-deliverable CLI script write this agent's output under
export const AGENTS: Readonly<Record<AgentName, AgentDefinition>> = Object.freeze({
  'pre-recon': {
    name: 'pre-recon',
    displayName: 'Pre-recon agent',
    prerequisites: [],
    promptTemplate: 'pre-recon-code',
    deliverableFilename: 'pre_recon_deliverable.md',
  },
  recon: {
    name: 'recon',
    displayName: 'Recon agent',
    prerequisites: ['pre-recon'],
    promptTemplate: 'recon',
    deliverableFilename: 'recon_deliverable.md',
  },
  'injection-vuln': {
    name: 'injection-vuln',
    displayName: 'Injection vuln agent',
    prerequisites: ['recon'],
    promptTemplate: 'vuln-injection',
    deliverableFilename: 'injection_analysis_deliverable.md',
  },
  'injection-exploit': {
    name: 'injection-exploit',
    displayName: 'Injection exploit agent',
    prerequisites: ['injection-vuln'],
    promptTemplate: 'exploit-injection',
    deliverableFilename: 'injection_exploitation_evidence.md',
  },
  report: {
    name: 'report',
    displayName: 'Report agent',
    prerequisites: ['injection-exploit'],
    promptTemplate: 'report-executive',
    deliverableFilename: 'comprehensive_security_assessment_report.md',
  },
});

// Phase names for metrics aggregation
export type PhaseName = 'pre-recon' | 'recon' | 'vulnerability-analysis' | 'exploitation' | 'reporting';

// Map agents to their corresponding phases (single source of truth)
export const AGENT_PHASE_MAP: Readonly<Record<AgentName, PhaseName>> = Object.freeze({
  'pre-recon': 'pre-recon',
  recon: 'recon',
  'injection-vuln': 'vulnerability-analysis',
  'injection-exploit': 'exploitation',
  report: 'reporting',
});

// Factory function for vulnerability queue validators.
//
// The analysis_deliverable.md is rendered via the writeDeliverable hook, which
// AgentExecutionService runs after validateAgentOutput but before the success
// commit — so a "both files exist" check here would race the renderer. The
// validator only checks queue.json, written by the submit-tool path in
// agent-execution.ts before this validator runs.
function createVulnValidator(vulnType: VulnType): AgentValidator {
  return async (sourceDir: string, logger: ActivityLogger): Promise<boolean> => {
    const queueFile = path.join(sourceDir, `${vulnType}_exploitation_queue.json`);
    const queueExists = await fs.pathExists(queueFile);
    if (!queueExists) {
      logger.warn(`Queue file missing for ${vulnType} — model did not call submit_exploitation_queue. Writing empty queue to allow pipeline to continue.`);
      await fs.ensureDir(sourceDir);
      await fs.writeFile(queueFile, JSON.stringify({ vulnerabilities: [] }, null, 2), 'utf8');
    }
    return true;
  };
}

// Exploitation agents — the evidence deliverable is rendered via the writeDeliverable
// hook after the agent succeeds (before the success commit), so a file-existence check
// here would race the renderer.
function createExploitValidator(_vulnType: VulnType): AgentValidator {
  return async (): Promise<boolean> => true;
}

// Playwright session mapping - assigns each agent to a specific session for browser isolation
// Keys are promptTemplate values from AGENTS registry
export const PLAYWRIGHT_SESSION_MAPPING: Record<string, PlaywrightSession> = Object.freeze({
  // Runs before any agent — non-concurrent, so agent1 is safe to share
  'validate-authentication': 'agent1',

  // Phase 1: Pre-reconnaissance
  'pre-recon-code': 'agent1',

  // Phase 2: Reconnaissance
  recon: 'agent2',

  // Phase 3: Vulnerability Analysis 
  'vuln-injection': 'agent1',

  // Phase 4: Exploitation
  'exploit-injection': 'agent1',

  // Phase 5: Reporting
  'report-executive': 'agent1',
});

// Direct agent-to-validator mapping - much simpler than pattern matching
export const AGENT_VALIDATORS: Record<AgentName, AgentValidator> = Object.freeze({
  // Pre-reconnaissance agent — skipped tools surface as renderer placeholders, not
  // activity failures. The deliverable file is written by the renderer after the agent
  // succeeds, so a file-existence check here would race the renderer.
  'pre-recon': async (): Promise<boolean> => true,

  // Reconnaissance agent — validation lives in runReconAgent post-processing.
  // The deliverable file is written by the renderer after the agent succeeds, so a
  // file-existence check here would race the renderer.
  recon: async (): Promise<boolean> => true,

  // Vulnerability analysis agents
  'injection-vuln': createVulnValidator('injection'),
  // Exploitation agents
  'injection-exploit': createExploitValidator('injection'),

  // Executive report agent
  report: async (sourceDir: string, logger: ActivityLogger): Promise<boolean> => {
    const reportFile = path.join(sourceDir, 'comprehensive_security_assessment_report.md');

    const reportExists = await fs.pathExists(reportFile);

    if (!reportExists) {
      logger.error('Missing required deliverable: comprehensive_security_assessment_report.md');
    }

    return reportExists;
  },
});
